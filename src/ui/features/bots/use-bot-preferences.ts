import { storedDesktopEnvelopeSchema as envelopeSchema } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { CommandResult } from "../../../shared/core.js";
import { AppError } from "../../../shared/core.js";
import { botSchema, type Bot } from "../../../shared/chat/bots.js";
import { envelope, errorMessage } from "../../lib/client.js";

const changesSchema = botSchema
  .pick({ name: true, description: true, tags: true, language: true })
  .extend({
    name: z.string().max(80),
    description: z.string().max(4000),
    tags: z.string().max(240),
  })
  .partial()
  .strict();
const cacheSchema = z.object({
  changes: changesSchema,
  pending: envelopeSchema.nullable(),
});
type Changes = z.infer<typeof changesSchema>;
type Field = keyof Changes;

/** Owns only the editable draft. The worker owns committed preferences and deduplication. */
export function useBotPreferences(
  bot: Bot,
  act: (
    command: Command,
    request?: Envelope,
  ) => Promise<CommandResult | undefined>,
) {
  const key = `bot-preferences:${bot.id}`;
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      const cached = raw
        ? cacheSchema.parse(JSON.parse(raw))
        : { changes: {}, pending: null };
      if (
        cached.pending &&
        (cached.pending.command.type !== "bot.preferences" ||
          cached.pending.command.botId !== bot.id)
      )
        throw Error("设置请求归属错误。");
      return { ...cached, blocked: false, error: "" };
    } catch {
      return {
        changes: {},
        pending: null,
        blocked: true,
        error: "设置草稿无法读取，原记录已保留。可备份该记录并重新编辑。",
      };
    }
  });
  const [changes, setChanges] = useState<Changes>(initial.changes);
  const draft = useRef<Changes>(initial.changes);
  const request = useRef<Envelope | null>(initial.pending);
  const [pending, setPending] = useState(initial.pending);
  const [blocked, setBlocked] = useState(initial.blocked);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState(initial.error);
  const [status, setStatus] = useState(
    initial.pending ? "上次保存结果尚未核实。" : "",
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function persist(next: Changes, nextRequest: Envelope | null) {
    localStorage.setItem(
      key,
      JSON.stringify({ changes: next, pending: nextRequest }),
    );
  }
  function change(next: Changes) {
    if (locked.current || request.current || blocked) return;
    draft.current = { ...draft.current, ...next };
    setChanges(draft.current);
    setStatus("");
    try {
      persist(draft.current, null);
      setError("");
    } catch {
      setError("草稿暂时无法保存在本机。请保留此页面并重试保存。");
    }
  }
  function revert(field: Field) {
    if (locked.current || request.current || blocked) return;
    const next = { ...draft.current };
    delete next[field];
    draft.current = next;
    setChanges(next);
    try {
      persist(next, null);
      setError("");
      setStatus("");
    } catch {
      setError("撤回的草稿尚未写入本机，请保留此页面并重试保存。");
    }
  }
  async function save() {
    if (locked.current || blocked) return;
    const next = { ...draft.current };
    if (next.name !== undefined) {
      if (next.name.trim()) next.name = next.name.trim();
      else delete next.name;
    }
    if (next.tags !== undefined) next.tags = next.tags.trim();
    if (next.description !== undefined)
      next.description = next.description.trim();
    if (!request.current) {
      for (const field of ["name", "description", "tags", "language"] as const)
        if (next[field] === bot[field]) delete next[field];
      if (!Object.keys(next).length) {
        draft.current = {};
        setChanges({});
        try {
          localStorage.removeItem(key);
          setError("");
          setStatus("");
        } catch {
          setError("草稿清理未完成，请保留此页面并重试保存。");
        }
        return;
      }
    }
    locked.current = true;
    setBusy(true);
    setError("");
    setStatus("保存中…");
    try {
      const current =
        request.current ??
        envelope({
          type: "bot.preferences",
          botId: bot.id,
          name: next.name ?? bot.name,
          description: next.description ?? bot.description,
          tags: next.tags ?? bot.tags,
          language: next.language ?? bot.language,
        });
      // No command is sent without a durable identity for unknown-response recovery.
      persist(next, current);
      request.current = current;
      draft.current = next;
      setChanges(next);
      setPending(current);
      const saved = await act(current.command, current);
      if (!saved) throw Error("保存结果未确认，请核实原请求。");
      // A remounted editor may be viewing the same pending request. Never erase a newer draft.
      const cached = localStorage.getItem(key);
      if (
        cached &&
        cacheSchema.parse(JSON.parse(cached)).pending?.id === current.id
      )
        localStorage.removeItem(key);
      if (alive.current) {
        draft.current = {};
        request.current = null;
        setChanges({});
        setPending(null);
        setStatus("已保存");
      }
    } catch (failure) {
      if (
        failure instanceof AppError &&
        [
          "invalid_input",
          "not_found",
          "unauthorized",
          "conflict",
          "capacity",
        ].includes(failure.code)
      ) {
        try {
          persist(next, null);
          request.current = null;
          if (alive.current) setPending(null);
        } catch {
          /* Retain the recorded request until its cache can be updated. */
        }
      }
      if (alive.current) {
        setStatus("");
        setError(`保存未确认，输入已保留。${errorMessage(failure)}`);
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function resetUnreadable() {
    try {
      const raw = localStorage.getItem(key);
      if (raw)
        localStorage.setItem(`${key}:unreadable:${crypto.randomUUID()}`, raw);
      localStorage.removeItem(key);
      setBlocked(false);
      setError("");
    } catch {
      setError("原记录未能备份，请检查本机存储后重试。");
    }
  }
  return {
    values: {
      name: changes.name ?? bot.name,
      description: changes.description ?? bot.description,
      tags: changes.tags ?? bot.tags,
      language: changes.language ?? bot.language,
    },
    locked: busy || !!pending || blocked,
    busy,
    pending,
    blocked,
    error,
    status,
    change,
    revert,
    save,
    resetUnreadable,
  };
}
