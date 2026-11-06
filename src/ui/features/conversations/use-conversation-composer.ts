import { useRef, useState } from "react";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import type { StateSetter } from "../../lib/react-state.js";
import { useAttachments } from "../files/attachments.js";
import { errorMessage } from "../../lib/client.js";
import type { ConversationViewModel } from "./use-conversation-session.js";
import { usePendingMessages } from "./use-pending-messages.js";
import type { useCommandQueue } from "../../lib/use-command-queue.js";
export function useConversationComposer(
  session: Pick<
    ConversationViewModel,
    | "state"
    | "conversation"
    | "selected"
    | "current"
    | "refresh"
    | "setHistoryWindow"
  >,
  act: ReturnType<typeof useCommandQueue>["act"],
  submit: ReturnType<typeof useCommandQueue>["submit"],
  busy: boolean,
  setBusy: StateSetter<boolean>,
  setError: StateSetter<string>,
) {
  const { state, conversation, selected, current, refresh, setHistoryWindow } =
    session;
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const { pendingMessages, sendMessage, retrySend, retainPending } =
    usePendingMessages(
      state,
      submit,
      (message) => {
        const latest = draftsRef.current[message.conversationId];
        if (latest !== undefined && latest !== message.draft)
          void act({
            type: "draft.save",
            conversationId: message.conversationId,
            text: latest,
          });
        setDrafts((old) =>
          old[message.conversationId] === undefined ||
          old[message.conversationId] === message.draft
            ? { ...old, [message.conversationId]: "" }
            : old,
        );
      },
      setBusy,
      setError,
    );
  const attachments = useAttachments(refresh, act);
  const currentUploads = attachments.uploads.filter(
    (upload) =>
      upload.conversationId === selected &&
      !conversation?.draftAttachments.some((file) => file.id === upload.id),
  );
  const uploading = currentUploads.some((file) => file.status !== "failed");
  const addFiles = (files: File[]) => {
    if (!conversation) {
      setError("请先选择收件人。");
      return;
    }
    try {
      attachments.add(conversation.id, files);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const draft = conversation
    ? (drafts[conversation.id] ?? conversation.draft)
    : "";
  const setDraft = (value: string) => {
    if (!conversation) return;
    setDrafts((old) => ({ ...old, [conversation.id]: value }));
    void act({
      type: "draft.save",
      conversationId: conversation.id,
      text: value,
    });
  };
  const send = async () => {
    if (
      !conversation ||
      (!draft.trim() &&
        !conversation.draftAttachments.length &&
        !conversation.draftSkills.length) ||
      busy ||
      uploading
    )
      return;
    const command: Extract<Command, { type: "message.send" }> = {
      type: "message.send",
      conversationId: conversation.id,
      text: draft.trim(),
      skills: conversation.draftSkills.map(({ id, botId, revision }) => ({
        id,
        botId,
        revision,
      })),
      ...(conversation.group?.draftRecipientIds.length
        ? { recipientIds: conversation.group.draftRecipientIds }
        : {}),
      ...(conversation.draftAttachments.length
        ? {
            attachmentIds: conversation.draftAttachments.map((file) => file.id),
          }
        : {}),
      ...(conversation.replyTo ? { replyToId: conversation.replyTo.id } : {}),
    };
    if (current.current === conversation.id) {
      setHistoryWindow(null);
    }
    await sendMessage(
      command,
      {
        text: command.text,
        replyTo: conversation.replyTo,
        attachments: conversation.draftAttachments,
        skills: conversation.draftSkills,
      },
      draft,
    );
  };
  function retainConversations(retained: Set<string>) {
    setDrafts((previous) =>
      Object.keys(previous).some((id) => !retained.has(id))
        ? Object.fromEntries(
            Object.entries(previous).filter(([id]) => retained.has(id)),
          )
        : previous,
    );
    retainPending(retained);
  }
  return {
    fileInput,
    input,
    setDrafts,
    draft,
    setDraft,
    send,
    attachments,
    currentUploads,
    uploading,
    addFiles,
    retainConversations,
    pendingMessages,
    retrySend,
  };
}
export type ComposerViewModel = ReturnType<typeof useConversationComposer>;
