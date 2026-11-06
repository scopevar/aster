import { useEffect, useRef, useState } from "react";
import { AppError } from "../../../shared/core.js";
import { type Snapshot } from "../../../shared/snapshot.js";
import type {
  DesktopCommand,
  DesktopEnvelope,
} from "../../../shared/desktop/desktop-commands.js";
import type { PendingMessageView } from "../messages/pending-message.js";
import { envelope, errorMessage } from "../../lib/client.js";
import type { StateSetter } from "../../lib/react-state.js";
import type { useCommandQueue } from "../../lib/use-command-queue.js";

type PendingSend = PendingMessageView & {
  request: DesktopEnvelope;
  conversationId: string;
  epoch: string;
  draft: string;
  draftCleared: boolean;
};
type MessageCommand = Extract<DesktopCommand, { type: "message.send" }>;

export function usePendingMessages(
  state: Snapshot,
  submit: ReturnType<typeof useCommandQueue>["submit"],
  onPersisted: (message: PendingSend) => void,
  setBusy: (busy: boolean) => void,
  setError: StateSetter<string>,
) {
  const records = useRef(new Map<string, PendingSend>());
  const [pendingMessages, setPendingMessages] = useState<PendingSend[]>([]);
  const current = useRef({ state, onPersisted });
  current.current = { state, onPersisted };
  const inFlight = useRef(false);
  const publish = () => setPendingMessages([...records.current.values()]);
  const clearDraft = (message: PendingSend) => {
    if (message.draftCleared) return message;
    const prepared = { ...message, draftCleared: true };
    records.current.set(message.id, prepared);
    current.current.onPersisted(prepared);
    return prepared;
  };
  const confirm = (message: PendingSend) => {
    if (message.status !== "confirmed") {
      records.current.set(message.id, {
        ...clearDraft(message),
        status: "confirmed",
        error: "",
      });
      setError((error) => (error === message.error ? "" : error));
    }
  };
  useEffect(() => {
    let changed = false;
    for (const message of records.current.values()) {
      if (message.epoch !== state.epoch) {
        records.current.delete(message.id);
        changed = true;
      } else {
        const cached = state.messages.find((item) => item.id === message.id);
        if (cached) {
          if (!message.draftCleared) {
            clearDraft(message);
            changed = true;
          }
          if (cached.sendStatus !== "pending") {
            confirm(records.current.get(message.id) ?? message);
            records.current.delete(message.id);
            changed = true;
          }
        }
      }
    }
    if (changed) publish();
  }, [state]);

  const deliver = async (message: PendingSend) => {
    if (inFlight.current || message.epoch !== current.current.state.epoch)
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    records.current.set(message.id, {
      ...message,
      status: "sending",
      startedAt: Date.now(),
      error: "",
    });
    publish();
    try {
      await submit(message.request.command, message.request);
      const remaining = records.current.get(message.id);
      if (remaining && remaining.epoch === current.current.state.epoch) {
        confirm(remaining);
        publish();
      }
    } catch (error) {
      const remaining = records.current.get(message.id);
      // A pushed snapshot can confirm the commit before a lost response rejects.
      if (remaining && remaining.epoch === current.current.state.epoch) {
        const cached = current.current.state.messages.find(
          (item) => item.id === message.id,
        );
        if (cached && cached.sendStatus !== "pending") {
          confirm(remaining);
          publish();
          return;
        }
        const rejected =
          error instanceof AppError &&
          [
            "invalid_input",
            "not_found",
            "conflict",
            "forbidden",
            "quota_exceeded",
          ].includes(error.code);
        records.current.set(message.id, {
          ...remaining,
          status: rejected ? "failed" : "unknown",
          error: errorMessage(error),
        });
        publish();
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const sendMessage = (
    command: MessageCommand,
    view: Omit<PendingMessageView, "id" | "status" | "error" | "startedAt">,
    draft: string,
  ) => {
    const existing = [...records.current.values()].find(
      (message) =>
        message.epoch === state.epoch &&
        message.status !== "confirmed" &&
        JSON.stringify(message.request.command) === JSON.stringify(command),
    );
    if (existing) return deliver(existing);
    for (const message of records.current.values())
      if (
        message.conversationId === command.conversationId &&
        message.status === "failed"
      )
        records.current.delete(message.id);
    const request = envelope(command);
    return deliver({
      ...view,
      request,
      id: request.id,
      conversationId: command.conversationId,
      epoch: state.epoch,
      draft,
      draftCleared: false,
      status: "sending",
      error: "",
    });
  };
  const retrySend = (id: string) => {
    const message = records.current.get(id);
    if (message) void deliver(message);
  };
  const retainPending = (retained: Set<string>) => {
    let changed = false;
    for (const message of records.current.values()) {
      if (!retained.has(message.conversationId)) {
        records.current.delete(message.id);
        changed = true;
      }
    }
    if (changed) publish();
  };
  return { pendingMessages, sendMessage, retrySend, retainPending };
}
