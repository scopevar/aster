import { Checkbox } from "../../components/checkbox.js";
import { Button, Input } from "@heroui/react";
import { storedDesktopEnvelopeSchema as envelopeSchema } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AppError } from "../../../shared/core.js";
import { type Bot } from "../../../shared/chat/bots.js";
import { envelope, execute, errorMessage } from "../../lib/client.js";
import { Modal } from "../../components/modal.js";
import "./bot-copy.css";

const draftSchema = z.object({
  name: z.string().max(80),
  includeSkills: z.boolean(),
  includeRoutines: z.boolean(),
});
const savedSchema = z.object({
  draft: draftSchema,
  pending: envelopeSchema.nullable(),
});
export function BotCopy({
  bot,
  onClose,
  onCopied,
}: {
  bot: Bot;
  onClose(): void;
  onCopied(id: string): void;
}) {
  const key = `bot-copy:${bot.id}`;
  const [initial] = useState(() => {
    const draft = {
      name: `${bot.name.slice(0, 77)} 副本`,
      includeSkills: true,
      includeRoutines: false,
    };
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { draft, pending: null, error: "" };
      const stored = savedSchema.parse(JSON.parse(raw));
      if (
        stored.pending &&
        (stored.pending.command.type !== "bot.copy" ||
          stored.pending.command.botId !== bot.id)
      )
        throw Error("副本请求归属错误。");
      return { ...stored, error: "" };
    } catch {
      return {
        draft,
        pending: null,
        error: "上次复制记录无法读取，原记录已保留。请先核实副本是否存在。",
      };
    }
  });
  const [draft, setDraft] = useState(initial.draft),
    [pending, setPending] = useState<Envelope | null>(initial.pending),
    [error, setError] = useState(initial.error),
    [busy, setBusy] = useState(false);
  const mounted = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const persist = (value: typeof draft, request: Envelope | null) =>
    localStorage.setItem(
      key,
      JSON.stringify({ draft: value, pending: request }),
    );
  const change = (value: typeof draft) => {
    try {
      persist(value, null);
      setDraft(value);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const submit = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const request =
        pending ?? envelope({ type: "bot.copy", botId: bot.id, ...draft });
      persist(draft, request);
      setPending(request);
      const result = await execute(request);
      if (!result.conversationId)
        throw Error("复制结果缺少会话编号，请重试原请求核实。");
      localStorage.removeItem(key);
      if (mounted.current) {
        setPending(null);
        onCopied(result.conversationId);
      }
    } catch (e) {
      if (
        e instanceof AppError &&
        e.code !== "unknown" &&
        e.code !== "internal"
      ) {
        try {
          persist(draft, null);
          if (mounted.current) setPending(null);
        } catch {
          /* Retain the original request identity when local persistence fails. */
        }
      }
      if (mounted.current) setError(errorMessage(e));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Modal title="复制 Bot" onClose={onClose}>
      <form
        className="bot-copy-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p>
          复制「{bot.name}」已保存的资料、回复语言和头像，创建独立 Bot
          与空会话。
        </p>
        <fieldset disabled={busy || !!pending || !!initial.error}>
          <label>
            副本名称
            <Input
              variant="secondary"
              fullWidth
              aria-label="副本名称"
              required
              maxLength={80}
              value={draft.name}
              onChange={(e) => change({ ...draft, name: e.target.value })}
            />
          </label>
          <Checkbox
            className="copy-option"
            isSelected={draft.includeSkills}
            isDisabled={busy || !!pending || !!initial.error}
            onChange={(selected) =>
              change({ ...draft, includeSkills: selected })
            }
          >
            复制当前技能（独立版本）
          </Checkbox>
          <Checkbox
            className="copy-option"
            isSelected={draft.includeRoutines}
            isDisabled={busy || !!pending || !!initial.error}
            onChange={(selected) =>
              change({ ...draft, includeRoutines: selected })
            }
          >
            复制例行任务定义（全部暂停，不含密钥）
          </Checkbox>
        </fieldset>
        <p className="muted">
          不复制聊天、草稿、记忆、附件、账户授权及工作文件。副本后续修改不会影响源
          Bot。
        </p>
        {error && <p role="alert">{error}</p>}
        <Button
          type="submit"
          variant="primary"
          className="primary"
          isDisabled={busy || !!initial.error || !draft.name.trim()}
        >
          {busy ? "复制中…" : pending ? "重试原复制" : "创建独立副本"}
        </Button>
      </form>
    </Modal>
  );
}
