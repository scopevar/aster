import { Button } from "@heroui/react";
import { storedDesktopEnvelopeSchema as envelopeSchema } from "../../shared/desktop/desktop-commands.js";
import type { DesktopEnvelope as Envelope } from "../../shared/desktop/desktop-commands.js";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import { type Bot } from "../../shared/chat/bots.js";
import { type Conversation } from "../../shared/chat/conversations.js";
import type { Deletion } from "../../shared/deletions.js";
import { envelope, errorMessage, execute } from "../lib/client.js";
import { Modal } from "../components/modal.js";
import "./deletion.css";

export type DeletionTarget = {
  kind: "bot" | "group";
  targetId: string;
  name: string;
};
const pendingKey = "entity-delete-pending";
const pendingSchema = envelopeSchema.refine(
  (value) => value.command.type === "entity.delete",
);
function readPending() {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(pendingKey) ?? "null",
    );
    if (value === null) return { request: null, error: "" };
    return {
      request: pendingSchema.parse(value),
      error: "",
    };
  } catch {
    return {
      request: null,
      error: "上次删除请求记录无法读取，原记录已保留，请先核实后台清理状态。",
    };
  }
}

export function DeletionController({
  target,
  jobs,
  onClose,
  onAccepted,
  onRefresh,
}: {
  target: DeletionTarget | null;
  jobs: Deletion[];
  onClose(): void;
  onAccepted(): void;
  onRefresh(): Promise<void>;
}) {
  const [initial] = useState(readPending);
  const request = useRef<Envelope | null>(initial.request);
  const [restored, setRestored] = useState(!!initial.request);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(initial.error);
  const saved = request.current?.command;
  const selected =
    (restored || target) && saved?.type === "entity.delete"
      ? { kind: saved.kind, targetId: saved.targetId, name: saved.expectedName }
      : target;
  useEffect(() => {
    if (target && !request.current) setError("");
  }, [target]);
  const close = () => {
    if (!pending) {
      setRestored(false);
      onClose();
    }
  };
  const send = async () => {
    if (!selected || pending) return;
    setPending(true);
    setError("");
    try {
      request.current ??= envelope({
        type: "entity.delete",
        kind: selected.kind,
        targetId: selected.targetId,
        expectedName: selected.name,
      });
      localStorage.setItem(pendingKey, JSON.stringify(request.current));
      await execute(request.current);
      localStorage.removeItem(pendingKey);
      request.current = null;
      setRestored(false);
      onAccepted();
      onClose();
      await onRefresh();
    } catch (error) {
      let cacheError = "";
      if (
        error instanceof AppError &&
        !["unknown", "unavailable"].includes(error.code)
      ) {
        // A rejected command has no side effect; a lost response must retain its original identity.
        try {
          localStorage.removeItem(pendingKey);
          request.current = null;
        } catch {
          cacheError = "本机删除请求记录未能清理，请检查本机存储后重试。";
        }
      }
      setError([errorMessage(error), cacheError].filter(Boolean).join(" "));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      {jobs.length > 0 && (
        <aside className="deletion-progress" aria-label="删除进度">
          {jobs.map((job) => (
            <div
              key={job.id}
              role={job.status === "failed" ? "alert" : "status"}
            >
              <span>
                {job.name}：
                {job.status === "queued"
                  ? "等待清理"
                  : job.status === "cleaning"
                    ? "正在停止运行并清理"
                    : "清理未完成"}
                {job.error ? ` · ${job.error}` : ""}
              </span>
              {job.status === "failed" && (
                <RetryDeletion
                  key={`${job.id}:${job.attempt}`}
                  id={job.id}
                  onRefresh={onRefresh}
                />
              )}
            </div>
          ))}
        </aside>
      )}
      {selected && (
        <Modal
          title={`删除“${selected.name}”`}
          onClose={close}
          variant="delete-confirm"
          busy={pending}
          hideCloseButton
        >
          <p>
            {selected.kind === "group"
              ? "这将永久删除群组及其聊天记录。其中的 Bot 不会被删除，仍可单独使用。此操作无法撤销。"
              : "这将永久删除 Bot 及其全部私聊、技能、记忆和Microsandbox 工作文件。群聊中已共享的消息会保留，发送者显示为已删除的 Bot。此操作无法撤销。"}
          </p>
          <p className="deletion-note">
            清理会先停止相关运行。独立备份不受影响。
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <Button
              variant="ghost"
              size="sm"
              autoFocus
              isDisabled={pending}
              onClick={close}
            >
              {request.current ? "关闭" : "取消"}
            </Button>
            <Button
              variant="danger"
              size="sm"
              className="destructive"
              isDisabled={pending}
              onClick={() => void send()}
            >
              {pending ? "正在提交…" : request.current ? "核实并重试" : "删除"}
            </Button>
          </footer>
        </Modal>
      )}
      {!selected && error && (
        <p className="deletion-progress error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
function RetryDeletion({
  id,
  onRefresh,
}: {
  id: string;
  onRefresh(): Promise<void>;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const request = useRef(envelope({ type: "deletion.retry", id }));
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        isDisabled={pending}
        onClick={() => {
          setPending(true);
          setError("");
          void execute(request.current)
            .then(onRefresh)
            .catch((error: unknown) => setError(errorMessage(error)))
            .finally(() => setPending(false));
        }}
      >
        {pending ? "提交中…" : "重试清理"}
      </Button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}

/** Only removes cache keys named by committed deletion receipts; unavailable storage is visible. */
export function sweepDeletedDrafts(
  keys: readonly string[],
  conversations: readonly Conversation[],
  bots: readonly Bot[],
) {
  const deleted = new Set(keys);
  // This runs only after a complete, connected snapshot. Keep the wire tombstones
  // compatible with older clients; shortcut requests belong to their conversation.
  const retained = new Set(
    conversations.map((conversation) => conversation.id),
  );
  const retainedBots = new Set(
    bots.filter((bot) => bot.lifecycle !== "deleted").map((bot) => bot.id),
  );
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index);
    const original = key?.replace(/:unreadable:[a-f0-9-]{36}$/, "");
    if (key && original && deleted.has(original)) {
      localStorage.removeItem(key);
      continue;
    }
    const match = key?.match(/^template-prompt:([a-f0-9-]{36})$/);
    const preferenceMatch = key?.match(
      /^bot-preferences:([a-f0-9-]{36})(?::unreadable:[a-f0-9-]{36})?$/,
    );
    const skillMatch = key?.match(
      /^market-skill-editor:([a-f0-9-]{36}):[a-f0-9-]{36}(?::unreadable:[a-f0-9-]{36})?$/,
    );
    if (key && skillMatch?.[1] && !retainedBots.has(skillMatch[1]))
      localStorage.removeItem(key);
    if (key && preferenceMatch?.[1] && !retainedBots.has(preferenceMatch[1]))
      localStorage.removeItem(key);
    if (key && match?.[1] && !retained.has(match[1]))
      localStorage.removeItem(key);
  }
  const raw = localStorage.getItem("group-recipient-draft");
  if (!raw) return;
  const draft = z
    .object({
      conversationId: z.string().nullable().optional(),
      memberIds: z.array(z.string()),
    })
    .passthrough()
    .safeParse(JSON.parse(raw));
  if (!draft.success) return;
  const deletedDraft =
    draft.data.conversationId &&
    !conversations.some((c) => c.id === draft.data.conversationId);
  // A deleted recipient does not own the user's entire group draft or its other recipients.
  if (deletedDraft) localStorage.removeItem("group-recipient-draft");
}
