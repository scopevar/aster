import { Button, Input, TextArea } from "@heroui/react";
import { Checkbox } from "../../components/checkbox.js";
import { storedDesktopEnvelopeSchema as envelopeSchema } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { CommandResult } from "../../../shared/core.js";
import { AppError } from "../../../shared/core.js";
import {
  memorySaveSchema,
  memoryViewSchema,
  type MemoryScope,
  type MemoryView,
  type MemoryEntry,
} from "../../../shared/memory.js";
import { desktop, envelope, errorMessage } from "../../lib/client.js";
import { Modal } from "../../components/modal.js";
import { useDraftRecovery } from "../../lib/use-draft-recovery.js";

const draftSchema = memorySaveSchema.extend({
  topic: z.string().max(100),
  content: z.string().max(800),
});
const savedSchema = z.object({
  draft: draftSchema,
  pending: envelopeSchema.nullable(),
});
const fresh = (scope: MemoryScope) => ({
  type: "memory.save" as const,
  scope,
  id: crypto.randomUUID(),
  revision: 0,
  topic: "",
  content: "",
});
const same = (a: MemoryScope, b: MemoryScope) =>
  a.botId === b.botId && a.conversationId === b.conversationId;
const labels = {
  queued: "排队中",
  proposing: "提炼中",
  verifying: "校验中",
  cancelling: "正在取消",
  completed: "已完成",
  conflict: "需要核实",
  failed: "失败",
  cancelled: "已取消",
};
export function MemoryManager({
  scope,
  name,
  act,
  onClose,
}: {
  scope: MemoryScope;
  name: string;
  act(command: Command, request?: Envelope): Promise<CommandResult | undefined>;
  onClose(): void;
}) {
  const key = `memory-editor:${scope.botId}:${scope.conversationId ?? "bot"}`;
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { draft: fresh(scope), pending: null, error: "" };
      const record = z
        .object({ pending: z.unknown() })
        .passthrough()
        .parse(JSON.parse(raw));
      const saved = savedSchema.parse(record),
        command = saved.pending?.command;
      if (
        !same(saved.draft.scope, scope) ||
        (command &&
          (!("scope" in command) ||
            !("botId" in command.scope) ||
            !same(command.scope, scope)))
      )
        throw Error("记忆草稿作用域无效。");
      return { ...saved, error: "" };
    } catch {
      return {
        draft: fresh(scope),
        pending: null,
        error: "记忆草稿无法读取，原记录已保留。",
      };
    }
  });
  const [draft, setDraft] = useState(initial.draft),
    [pending, setPending] = useState<Envelope | null>(initial.pending),
    [error, setError] = useState(initial.error),
    [busy, setBusy] = useState(false);
  const { blocked, recover } = useDraftRecovery(key, initial.error, setError);
  const [view, setView] = useState<MemoryView | null>(null),
    [readError, setReadError] = useState(""),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<MemoryEntry | null>(null);
  const mounted = useRef(true),
    refresh = useRef<() => void>(() => {});
  useEffect(() => {
    mounted.current = true;
    let disposed = false,
      inflight = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (disposed || inflight) return;
      if (timer) clearTimeout(timer);
      inflight = true;
      try {
        const value = memoryViewSchema.parse(await desktop.memory(scope));
        if (!disposed) {
          setView(value);
          setReadError("");
        }
      } catch (e) {
        if (!disposed) setReadError(errorMessage(e));
      } finally {
        inflight = false;
        if (!disposed)
          timer = setTimeout(() => {
            void load();
          }, 1500);
      }
    };
    refresh.current = () => {
      void load();
    };
    void load();
    return () => {
      disposed = true;
      mounted.current = false;
      if (timer) clearTimeout(timer);
      refresh.current = () => {};
    };
  }, [scope]);
  const persist = (next: typeof draft, request: Envelope | null) => {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ draft: next, pending: request }),
      );
      return true;
    } catch {
      setError("无法保存恢复记录，请释放本地存储后重试。");
      return false;
    }
  };
  const change = (next: typeof draft) => {
    if (blocked) return;
    if (persist(next, null)) {
      setDraft(next);
      setError("");
    }
  };
  const submit = async (command: Command) => {
    if (busy || blocked) return;
    let request: Envelope;
    try {
      request = pending ?? envelope(command);
    } catch {
      setError("请填写有效的记忆主题和内容。");
      return;
    }
    if (!persist(draft, request)) return;
    setPending(request);
    setBusy(true);
    setError("");
    try {
      const result = await act(request.command, request);
      if (!result)
        throw new AppError("unknown", "操作结果未知，请重试原请求。");
      if (!mounted.current) return;
      const next =
        request.command.type === "memory.save"
          ? { ...request.command, revision: request.command.revision + 1 }
          : request.command.type === "memory.forget" &&
              request.command.id === draft.id
            ? fresh(scope)
            : draft;
      if (persist(next, null)) {
        setDraft(next);
        setPending(null);
        setSelected(null);
      }
      refresh.current();
    } catch (e) {
      if (!mounted.current) return;
      setError(errorMessage(e));
      if (
        e instanceof AppError &&
        e.code !== "unknown" &&
        e.code !== "unavailable" &&
        persist(draft, null)
      )
        setPending(null);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const disabled = busy || !!pending || blocked;
  const entries =
    view?.entries.filter((item) =>
      `${item.topic} ${item.content}`.includes(query),
    ) ?? [];
  return (
    <Modal title={`${name} 的记忆`} onClose={onClose} wide>
      <div className="memory-manager">
        <p className="muted">
          {scope.conversationId
            ? "仅用于这个 Bot 在当前群聊中的交流。"
            : "仅用于这个 Bot 的单聊，可跨会话使用。"}{" "}
          忘记会停止后续检索，不删除聊天中已经说过的话。
        </p>
        <div className="memory-auto">
          <Checkbox
            aria-label="自动提炼新对话"
            isDisabled={disabled || !view}
            isSelected={view?.automatic ?? false}
            onChange={(selected) => {
              if (view)
                void submit({
                  type: "memory.auto",
                  scope,
                  revision: view.revision,
                  enabled: selected,
                });
            }}
          >
            自动提炼新对话
          </Checkbox>
          <span className="muted">使用 Pi 当前配置的模型进行提炼和校验</span>
        </div>
        {readError && (
          <p role="alert" className="error">
            {readError}
            <Button variant="ghost" size="sm" onClick={() => refresh.current()}>
              重新读取
            </Button>
          </p>
        )}
        {!view && <p role="status">正在读取记忆…</p>}
        {blocked && (
          <p role="alert">
            {error}
            <Button
              variant="secondary"
              size="sm"
              type="button"
              className="secondary"
              onClick={recover}
            >
              备份原记录并重新编辑
            </Button>
          </p>
        )}
        <div className="memory-columns">
          <section className="memory-list" aria-label="记忆条目">
            <Input
              variant="secondary"
              aria-label="搜索记忆"
              placeholder="搜索记忆"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button
              variant="secondary"
              size="sm"
              className="secondary"
              isDisabled={disabled}
              onClick={() => {
                change(fresh(scope));
                setSelected(null);
              }}
            >
              新增记忆
            </Button>
            {view && entries.length === 0 && <p className="muted">暂无记忆</p>}
            {entries.map((item) => (
              <Button
                variant="ghost"
                size="sm"
                key={item.id}
                className="memory-entry"
                isDisabled={disabled}
                aria-pressed={draft.id === item.id}
                onClick={() => {
                  change({
                    type: "memory.save",
                    scope,
                    id: item.id,
                    revision: item.revision,
                    topic: item.topic,
                    content: item.content,
                  });
                  setSelected(item);
                }}
              >
                <strong>{item.topic}</strong>
                <span>{item.content}</span>
                <small>
                  {item.origin === "manual" ? "手动保存" : "自动提炼"} · v
                  {item.revision}
                </small>
              </Button>
            ))}
          </section>
          <form
            className="memory-editor"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(draft);
            }}
          >
            <label>
              主题
              <Input
                variant="secondary"
                aria-label="记忆主题"
                maxLength={100}
                value={draft.topic}
                disabled={disabled}
                onChange={(e) => change({ ...draft, topic: e.target.value })}
              />
            </label>
            <label>
              内容
              <TextArea
                variant="secondary"
                aria-label="记忆内容"
                maxLength={800}
                value={draft.content}
                disabled={disabled}
                onChange={(e) => change({ ...draft, content: e.target.value })}
              />
            </label>
            {selected?.sourceQuote && (
              <div className="memory-source">
                <span>来源原文</span>
                <blockquote>{selected.sourceQuote}</blockquote>
                <small>消息 {selected.sourceMessageId}</small>
              </div>
            )}
            <div className="memory-buttons">
              <Button
                variant="primary"
                size="sm"
                type="submit"
                className="primary"
                isDisabled={
                  busy ||
                  blocked ||
                  (!pending && (!draft.topic.trim() || !draft.content.trim()))
                }
              >
                {pending ? "重试原记忆请求" : busy ? "保存中…" : "保存记忆"}
              </Button>
              {draft.revision > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  className="secondary"
                  isDisabled={disabled}
                  onClick={() => {
                    void submit({
                      type: "memory.forget",
                      scope,
                      id: draft.id,
                      revision: draft.revision,
                    });
                  }}
                >
                  忘记这条记忆
                </Button>
              )}
            </div>
            {pending && (
              <p role="status" className="muted">
                请求尚未确认；保留原参数，重试不会重复保存。
              </p>
            )}
            {error && !blocked && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </form>
        </div>
        <section className="memory-jobs" aria-label="记忆提炼记录">
          <h3>最近提炼</h3>
          {view && !view.jobs.length && (
            <p className="muted">开启后，从新的已完成对话中提炼。</p>
          )}
          {view?.jobs.map((job) => (
            <div className="memory-job" key={job.id}>
              <span>{labels[job.status]}</span>
              {job.error && <p>{job.error}</p>}
              {["queued", "proposing", "verifying"].includes(job.status) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  isDisabled={disabled}
                  onClick={() => {
                    void submit({
                      type: "memory.job",
                      scope,
                      id: job.id,
                      action: "cancel",
                    });
                  }}
                >
                  取消提炼
                </Button>
              ) : ["failed", "conflict", "cancelled"].includes(job.status) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  isDisabled={disabled}
                  onClick={() => {
                    void submit({
                      type: "memory.job",
                      scope,
                      id: job.id,
                      action: "retry",
                    });
                  }}
                >
                  重试提炼
                </Button>
              ) : null}
            </div>
          ))}
        </section>
      </div>
    </Modal>
  );
}
