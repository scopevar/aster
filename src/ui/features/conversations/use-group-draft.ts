import type { PendingMessageView } from "../messages/pending-message.js";
import { storedDesktopEnvelopeSchema as envelopeSchema } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { type Attachment } from "../../../shared/files/attachments.js";
import type { Bot } from "../../../shared/chat/bots.js";
import type { CommandResult } from "../../../shared/core.js";
import type { Conversation } from "../../../shared/chat/conversations.js";
import { AppError } from "../../../shared/core.js";
import {
  skillSummarySchema,
  type SkillSummary,
} from "../../../shared/tools/skills.js";
import { type useAttachments } from "../files/attachments.js";
import { desktop, envelope, errorMessage } from "../../lib/client.js";
const draftKey = "group-recipient-draft";
function readDraft() {
  const empty = draftSchema.parse({ memberIds: [], text: "" });
  try {
    const raw = localStorage.getItem(draftKey);
    const value: unknown = raw ? JSON.parse(raw) : empty;
    const record = z.record(z.string(), z.unknown()).parse(value);
    return {
      draft: draftSchema.parse(record),
      error: "",
    };
  } catch {
    return {
      draft: empty,
      error: "群聊草稿无法读取，原记录已保留；重新输入后会替换该草稿。",
    };
  }
}
const draftSchema = z.object({
  hostBotId: z.uuid().nullable().optional(),
  memberIds: z.array(z.uuid()).max(8),
  text: z.string().max(32000),
  skills: z.array(skillSummarySchema).max(4).default([]),
  conversationId: z.uuid().nullable().default(null),
  prepareId: z.uuid().default(() => crypto.randomUUID()),
  prepareMemberIds: z.array(z.uuid()).max(8).nullable().default(null),
  sendId: z.uuid().default(() => crypto.randomUUID()),
  pendingSend: envelopeSchema
    .refine((e) => e.command.type === "group.start")
    .nullable()
    .default(null),
});
export function useGroupDraft({
  bots,
  onClose,
  onCreated,
  act,
  conversations,
  uploads,
}: {
  bots: Bot[];
  onClose(): void;
  onCreated(id: string): void;
  act(command: Command, request?: Envelope): Promise<CommandResult | undefined>;
  conversations: Conversation[];
  uploads: ReturnType<typeof useAttachments>;
}) {
  const [initial] = useState(readDraft);
  const [draft, setDraft] = useState(initial.draft);
  const [attempt, setAttempt] = useState<Envelope | null>(
    initial.draft.pendingSend,
  );
  const [sendStatus, setSendStatus] =
    useState<PendingMessageView["status"]>("unknown");
  const [sendError, setSendError] = useState("");
  const [skills, setSkills] = useState<SkillSummary[]>([]),
    [skillManager, setSkillManager] = useState(false),
    [skillPreview, setSkillPreview] = useState<SkillSummary | null>(null),
    [catalogRevision, setCatalogRevision] = useState(0);
  const memberKey = draft.memberIds
    .filter((id) => bots.some((bot) => bot.id === id))
    .join(",");
  useEffect(() => {
    if (!memberKey) {
      setSkills([]);
      return;
    }
    let disposed = false;
    void desktop
      .skillCatalog(memberKey.split(","))
      .then((raw) => {
        const list = z.array(skillSummarySchema).parse(raw);
        if (!disposed) setSkills(list);
      })
      .catch((e) => {
        if (!disposed) setError(errorMessage(e));
      });
    return () => {
      disposed = true;
    };
  }, [memberKey, catalogRevision]);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [query, setQuery] = useState(""),
    [open, setOpen] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(initial.error);
  const [active, setActive] = useState(0);
  const locked = busy || draft.pendingSend !== null;
  const input = useRef<HTMLTextAreaElement>(null);
  const members = draft.memberIds.flatMap((id) =>
    bots.filter((b) => b.id === id),
  );
  const missingMembers = members.length !== draft.memberIds.length;
  const prepared = conversations.find((c) => c.id === draft.conversationId);
  const files = prepared?.draftAttachments ?? [];
  const pending = uploads.uploads.filter(
    (u) =>
      u.conversationId === draft.conversationId &&
      !files.some((f) => f.id === u.id),
  );
  const uploading = pending.some((u) => u.status !== "failed");
  const candidates = bots.filter(
    (b) => !draft.memberIds.includes(b.id) && b.name.includes(query),
  );
  const change = (next: typeof draft) => {
    try {
      const revised = { ...next, sendId: crypto.randomUUID() };
      localStorage.setItem(draftKey, JSON.stringify(revised));
      setDraft(revised);
      setAttempt(null);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };
  const choose = (id: string) => {
    if (locked) return;
    if (draft.memberIds.length >= 8) {
      setError("每个群聊最多 8 个 Bot。");
      return;
    }
    change({ ...draft, memberIds: [...draft.memberIds, id] });
    setQuery("");
    setActive(0);
  };
  const removeMember = (id: string) => {
    if (locked) return;
    change({
      ...draft,
      memberIds: draft.memberIds.filter((memberId) => memberId !== id),
      hostBotId: draft.hostBotId === id ? undefined : draft.hostBotId,
      skills: draft.skills.filter((skill) => skill.botId !== id),
    });
  };
  const send = async (retry?: Envelope) => {
    if (
      busy ||
      uploading ||
      (!draft.pendingSend &&
        (missingMembers ||
          !members.length ||
          (!draft.text.trim() && !files.length && !draft.skills.length)))
    )
      return;
    setBusy(true);
    setError("");
    const command: Command = retry?.command ??
      draft.pendingSend?.command ?? {
        type: "group.start",
        memberIds: draft.memberIds,
        hostBotId:
          draft.hostBotId === undefined
            ? (draft.memberIds[0] ?? null)
            : draft.hostBotId,
        text: draft.text.trim(),
        skills: draft.skills.map(({ id, botId, revision }) => ({
          id,
          botId,
          revision,
        })),
        ...(draft.conversationId
          ? {
              conversationId: draft.conversationId,
              attachmentIds: files.map((f) => f.id),
            }
          : {}),
      };
    const request = retry ??
      draft.pendingSend ?? {
        ...envelope(command),
        id: draft.sendId,
      };
    const sending = { ...draft, pendingSend: request };
    setAttempt(request);
    setSendStatus("sending");
    setSendError("");
    try {
      localStorage.setItem(draftKey, JSON.stringify(sending));
      setDraft(sending);
      const result = await act(command, request);
      if (!result?.conversationId)
        throw Error("创建尚未确认，草稿已保留；重试不会重复创建。");
      if (!mounted.current) return;
      localStorage.removeItem(draftKey);
      if (mounted.current) onCreated(result.conversationId);
    } catch (e) {
      if (!mounted.current) return;
      setSendStatus("unknown");
      setSendError(errorMessage(e));
      if (
        e instanceof AppError &&
        [
          "invalid_input",
          "not_found",
          "conflict",
          "capacity",
          "unauthorized",
        ].includes(e.code)
      ) {
        setSendStatus("failed");
        const editable = {
          ...draft,
          pendingSend: null,
          sendId: crypto.randomUUID(),
        };
        try {
          localStorage.setItem(draftKey, JSON.stringify(editable));
          setDraft(editable);
        } catch {
          setError("请求被拒绝，但本地草稿无法更新；原请求仍保留。");
          return;
        }
      }
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const addFiles = async (selected: File[]) => {
    if (locked || missingMembers || !members.length || !selected.length) return;
    setBusy(true);
    setError("");
    try {
      const preparedDraft = {
        ...draft,
        prepareMemberIds: draft.prepareMemberIds ?? draft.memberIds,
      };
      localStorage.setItem(draftKey, JSON.stringify(preparedDraft));
      setDraft(preparedDraft);
      let id = draft.conversationId;
      if (!id) {
        const command: Command = {
          type: "group.prepare",
          memberIds: preparedDraft.prepareMemberIds,
        };
        let result: CommandResult | undefined;
        try {
          result = await act(command, {
            ...envelope(command),
            id: draft.prepareId,
          });
        } catch (error) {
          // Only an explicit no-commit rejection permits replacing the request.
          // A lost reply must retain both the ID and the original recipients.
          if (
            error instanceof AppError &&
            [
              "invalid_input",
              "not_found",
              "conflict",
              "capacity",
              "unauthorized",
            ].includes(error.code)
          ) {
            const retryable = {
              ...preparedDraft,
              prepareId: crypto.randomUUID(),
              prepareMemberIds: null,
            };
            localStorage.setItem(draftKey, JSON.stringify(retryable));
            setDraft(retryable);
          }
          throw error;
        }
        if (!result?.conversationId) throw Error("附件草稿尚未确认，请重试。");
        id = result.conversationId;
        const next = { ...preparedDraft, conversationId: id };
        localStorage.setItem(draftKey, JSON.stringify(next));
        setDraft(next);
      }
      uploads.add(id, selected);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return {
    retryFirstSend: () => send(attempt ?? undefined),
    pendingMessage:
      attempt?.command.type === "group.start"
        ? ({
            id: attempt.id,
            text: attempt.command.text,
            replyTo: null,
            attachments: files,
            skills: draft.skills,
            status: sendStatus,
            error: sendError,
          } satisfies PendingMessageView)
        : null,
    bots,
    onClose,
    act,
    uploads,
    draft,
    setDraft,
    skills,
    skillManager,
    setSkillManager,
    skillPreview,
    setSkillPreview,
    setCatalogRevision,
    preview,
    setPreview,
    fileInput,
    mounted,
    query,
    setQuery,
    open,
    setOpen,
    busy,
    setBusy,
    error,
    setError,
    active,
    setActive,
    locked,
    input,
    members,
    missingMembers,
    prepared,
    files,
    pending,
    uploading,
    candidates,
    change,
    choose,
    removeMember,
    send,
    addFiles,
  };
}
export type GroupDraftViewModel = ReturnType<typeof useGroupDraft>;
