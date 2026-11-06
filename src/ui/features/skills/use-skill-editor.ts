import { storedDesktopEnvelopeSchema as envelopeSchema } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { CommandResult } from "../../../shared/core.js";
import { AppError } from "../../../shared/core.js";
import { type Bot } from "../../../shared/chat/bots.js";
import {
  skillSaveSchema,
  skillSchema,
  type SkillSummary,
} from "../../../shared/tools/skills.js";
import { desktop, envelope, errorMessage } from "../../lib/client.js";
const editorDraftSchema = z.object({
  command: skillSaveSchema,
  pending: envelopeSchema.nullable(),
  saved: skillSaveSchema.nullable().optional(),
});
function fresh(botId: string) {
  return {
    type: "skill.save" as const,
    id: crypto.randomUUID(),
    botId,
    revision: 0,
    name: "",
    description: "",
    body: "",
  };
}
export function useSkillEditor({
  bots,
  skills,
  act,
  onClose,
  initialDraft,
}: {
  bots: Bot[];
  skills: SkillSummary[];
  act(command: Command, request?: Envelope): Promise<CommandResult | undefined>;
  onClose(): void;
  initialDraft?: {
    id: string;
    body: string;
    name: string;
    description: string;
  };
}) {
  const initialBot = bots[0]?.id ?? "",
    key = `skill-editor:${initialBot}${initialDraft ? `:${initialDraft.id}` : ""}`;
  const [initial] = useState(() => {
    // Incomplete names/bodies are valid editor drafts, but never valid commands.
    const draftSchema = editorDraftSchema.extend({
      command: skillSaveSchema.extend({
        name: z.string().max(80),
        description: z.string().max(500),
        body: z.string().max(32000),
      }),
    });
    try {
      const raw = localStorage.getItem(key);
      if (!raw)
        return {
          command: initialDraft
            ? {
                ...fresh(initialBot),
                name: initialDraft.name,
                description: initialDraft.description,
                body: initialDraft.body,
              }
            : fresh(initialBot),
          pending: null,
          saved: null,
          error: "",
        };
      const record = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
      const saved = draftSchema.parse(record);
      if (!bots.some((b) => b.id === saved.command.botId))
        throw Error("Bot scope changed");
      if (
        saved.saved &&
        (saved.saved.id !== saved.command.id ||
          saved.saved.botId !== saved.command.botId ||
          saved.saved.revision !== saved.command.revision)
      )
        throw Error("Invalid saved skill baseline");
      const request = saved.pending?.command;
      if (
        request &&
        ((request.type !== "skill.save" && request.type !== "skill.delete") ||
          request.id !== saved.command.id ||
          request.botId !== saved.command.botId ||
          request.revision !== saved.command.revision)
      )
        throw Error("Invalid pending skill request");
      if (request?.type === "skill.save") {
        const checked = skillSaveSchema.safeParse(saved.command);
        if (
          !checked.success ||
          JSON.stringify(checked.data) !== JSON.stringify(request)
        )
          throw Error("Pending skill payload changed");
      }
      return { ...saved, error: "" };
    } catch {
      return {
        command: fresh(initialBot),
        pending: null,
        saved: null,
        error: "技能草稿格式无效，原记录未覆盖。",
      };
    }
  });
  const [draft, setDraft] = useState(initial.command),
    [pending, setPending] = useState<Envelope | null>(initial.pending),
    [error, setError] = useState(initial.error),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState("");
  const generation = useRef(0);
  const [blocked, setBlocked] = useState(!!initial.error);
  const lastSaved = useRef(initial.saved ?? null);
  const sending = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const persist = (
    command: typeof draft,
    request: Envelope | null,
    saved = lastSaved.current,
  ) => {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ command, pending: request, saved }),
      );
      return true;
    } catch {
      setError("无法保存编辑草稿，请释放本地存储后重试。");
      return false;
    }
  };
  const change = (patch: Partial<typeof draft>) => {
    const next = { ...draft, ...patch };
    if (persist(next, null)) {
      setDraft(next);
      setError("");
    }
  };
  const load = async (skill: Omit<SkillSummary, "updatedAt">) => {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const value = skillSchema.parse(
        await desktop.skillContent({
          id: skill.id,
          botId: skill.botId,
          revision: skill.revision,
        }),
      );
      if (current !== generation.current) return;
      const next = {
        type: "skill.save" as const,
        id: value.id,
        botId: value.botId,
        revision: value.revision,
        name: value.name,
        description: value.description,
        body: value.body,
      };
      if (
        value.id !== skill.id ||
        value.botId !== skill.botId ||
        value.revision !== skill.revision
      )
        throw Error("技能归属或版本不一致，请重新读取。");
      if (persist(next, null, next)) {
        lastSaved.current = next;
        setDraft(next);
      }
    } catch (e) {
      if (current === generation.current) setError(errorMessage(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const submit = async (remove = false) => {
    if (busy || sending.current || blocked) return;
    const current = generation.current;
    const command: Command = remove
      ? {
          type: "skill.delete",
          id: draft.id,
          botId: draft.botId,
          revision: draft.revision,
        }
      : draft;
    let request: Envelope;
    try {
      request = pending ?? envelope(command);
    } catch {
      setError("请填写有效的技能名称、描述和正文。");
      return;
    }
    if (!persist(draft, request)) return;
    sending.current = true;
    setPending(request);
    setBusy(true);
    setError("");
    try {
      const result = await act(request.command, request);
      if (!result) throw Error("技能保存结果尚未确认。");
      if (current !== generation.current) return;
      const next =
        request.command.type === "skill.delete"
          ? fresh(draft.botId)
          : request.command.type === "skill.save"
            ? { ...request.command, revision: request.command.revision + 1 }
            : draft;
      const baseline = next.revision ? next : null;
      if (!persist(next, null, baseline)) return;
      lastSaved.current = baseline;
      setDraft(next);
      setPending(null);
    } catch (e) {
      if (current !== generation.current) return;
      setError(errorMessage(e));
      if (e instanceof AppError && e.code === "conflict") setBlocked(true);
      if (
        e instanceof AppError &&
        [
          "conflict",
          "invalid_input",
          "not_found",
          "capacity",
          "unauthorized",
        ].includes(e.code)
      ) {
        setPending(null);
        persist(draft, null);
      }
    } finally {
      sending.current = false;
      if (current === generation.current) setBusy(false);
    }
  };
  const recover = async () => {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null)
        localStorage.setItem(`${key}:unreadable:${crypto.randomUUID()}`, raw);
      setBlocked(false);
      const next = fresh(initialBot);
      if (persist(next, null, null)) {
        lastSaved.current = null;
        setDraft(next);
        setError("");
      }
    } catch (failure) {
      if (current !== generation.current) return;
      setBlocked(true);
      setError(`重新读取失败，原记录已保留：${errorMessage(failure)}`);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const visible = skills.filter(
    (s) =>
      s.botId === draft.botId &&
      `${s.name} ${s.description}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  return {
    bots,
    onClose,
    draft,
    setDraft,
    pending,
    error,
    setError,
    busy,
    query,
    setQuery,
    blocked,
    lastSaved,
    persist,
    change,
    load,
    submit,
    recover,
    visible,
  };
}
export type SkillEditorViewModel = ReturnType<typeof useSkillEditor>;
