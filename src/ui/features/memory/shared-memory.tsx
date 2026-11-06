import { Button, Input, TextArea } from "@heroui/react";
import { storedDesktopEnvelopeSchema as envelopeSchema } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import type { CommandResult } from "../../../shared/core.js";
import { AppError } from "../../../shared/core.js";
import {
  sharedMemorySaveSchema,
  sharedMemoryViewSchema,
  type SharedMemoryEntry,
  type SharedMemoryScope,
  type SharedMemoryView,
} from "../../../shared/memory.js";
import { desktop, envelope, errorMessage } from "../../lib/client.js";
import { useDraftRecovery } from "../../lib/use-draft-recovery.js";
import { Icon } from "../../components/icons.js";
import "./shared-memory-page.css";

const draftSchema = sharedMemorySaveSchema.extend({
  topic: z.string().max(100),
  content: z.string().max(800),
});
const savedSchema = z.object({
  draft: draftSchema,
  pending: envelopeSchema.nullable(),
});
const fresh = (scope: SharedMemoryScope) => ({
  type: "memory.shared.save" as const,
  scope,
  id: crypto.randomUUID(),
  revision: 0,
  topic: "",
  content: "",
});
const same = (a: SharedMemoryScope, b: SharedMemoryScope) =>
  a.kind === b.kind &&
  (a.kind === "account" || b.kind === "account" || a.projectId === b.projectId);
const storageKey = (scope: SharedMemoryScope) =>
  `shared-memory-editor:${scope.kind}:${scope.kind === "project" ? scope.projectId : "account"}`;

export function SharedMemoryManager({
  scope,
  act,
  onClose,
}: {
  scope: SharedMemoryScope;
  act(command: Command, request?: Envelope): Promise<CommandResult | undefined>;
  onClose(): void;
}) {
  const key = storageKey(scope);
  const page = useRef<HTMLElement>(null);
  const topicInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    page.current?.focus({ preventScroll: true });
  }, []);
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { draft: fresh(scope), pending: null, error: "" };
      const saved = savedSchema.parse(JSON.parse(raw));
      const command = saved.pending?.command;
      if (
        !same(saved.draft.scope, scope) ||
        (command &&
          (!("scope" in command) ||
            !("kind" in command.scope) ||
            !same(command.scope, scope)))
      )
        throw Error("共享记忆草稿作用域无效。");
      return { ...saved, error: "" };
    } catch {
      return {
        draft: fresh(scope),
        pending: null,
        error: "共享记忆草稿无法读取，原记录已保留。",
      };
    }
  });
  const [draft, setDraft] = useState(initial.draft),
    [pending, setPending] = useState<Envelope | null>(initial.pending),
    [error, setError] = useState(initial.error),
    [busy, setBusy] = useState(false);
  const { blocked, recover } = useDraftRecovery(key, initial.error, setError);
  const [view, setView] = useState<SharedMemoryView | null>(null),
    [readError, setReadError] = useState("");
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
        const value = sharedMemoryViewSchema.parse(
          await desktop.sharedMemory(scope),
        );
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
  const persist = (next: typeof draft, request: Envelope | null): boolean => {
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
      setError("请填写有效的共享记忆主题和内容。");
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
        request.command.type === "memory.shared.save"
          ? { ...request.command, revision: request.command.revision + 1 }
          : request.command.type === "memory.shared.forget" &&
              request.command.id === draft.id
            ? fresh(scope)
            : draft;
      if (persist(next, null)) {
        setDraft(next);
        setPending(null);
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
      refresh.current();
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const disabled = busy || !!pending || blocked;
  const title = scope.kind === "account" ? "账户记忆" : "项目记忆";
  return (
    <section
      ref={page}
      tabIndex={-1}
      className="shared-memory-page"
      aria-label={title}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          !event.defaultPrevented
        ) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="memory-manager">
        <div className="memory-description">
          <p>
            {scope.kind === "account"
              ? "此账户的 Bot 共用这些记忆。"
              : "此项目的 Bot 共用这些记忆。"}
          </p>
          <p>不改写聊天记录，忘记后不再使用。</p>
        </div>
        {readError && (
          <p role="alert" className="error">
            {readError}
            <Button
              variant="secondary"
              type="button"
              onPress={() => refresh.current()}
            >
              重新加载
            </Button>
          </p>
        )}
        {blocked && (
          <p role="alert">
            {error}
            <Button variant="secondary" type="button" onPress={recover}>
              备份原记录并重新编辑
            </Button>
          </p>
        )}
        <div className="memory-columns">
          <section className="settings-section" aria-label="共享记忆条目">
            <h2>记忆列表</h2>
            <div className="setting-group memory-list">
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                type="button"
                isDisabled={disabled}
                onPress={() => {
                  change(fresh(scope));
                  topicInput.current?.focus({ preventScroll: true });
                }}
              >
                <Icon name="plus" size={14} />
                新增记忆
              </Button>
              {!view && !readError && (
                <p className="memory-empty" role="status">
                  正在读取共享记忆…
                </p>
              )}
              {view && view.entries.length === 0 && (
                <p className="memory-empty">还没有记忆，添加一条吧。</p>
              )}
              {view?.entries.map((item: SharedMemoryEntry) => (
                <Button
                  variant={draft.id === item.id ? "tertiary" : "ghost"}
                  key={item.id}
                  className="memory-entry"
                  type="button"
                  isDisabled={disabled}
                  aria-pressed={draft.id === item.id}
                  onPress={() =>
                    change({
                      type: "memory.shared.save",
                      scope,
                      id: item.id,
                      revision: item.revision,
                      topic: item.topic,
                      content: item.content,
                    })
                  }
                >
                  <strong>{item.topic}</strong>
                  <span>{item.content}</span>
                  <small>已保存</small>
                </Button>
              ))}
            </div>
          </section>
          <section className="settings-section" aria-label="记忆内容">
            <h2>记忆内容</h2>
            <form
              className="setting-group memory-editor"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(draft);
              }}
            >
              <label>
                主题
                <Input
                  variant="secondary"
                  fullWidth
                  aria-label="共享记忆主题"
                  placeholder="例如，回复偏好"
                  ref={topicInput}
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
                  fullWidth
                  aria-label="共享记忆内容"
                  placeholder="写下你希望 Bot 记住的信息"
                  maxLength={800}
                  rows={6}
                  value={draft.content}
                  disabled={disabled}
                  onChange={(e) =>
                    change({ ...draft, content: e.target.value })
                  }
                />
              </label>
              {error && !blocked && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <div className="memory-buttons">
                {draft.revision > 0 && (
                  <Button
                    variant="danger-soft"
                    type="button"
                    isDisabled={disabled}
                    onPress={() => {
                      void submit({
                        type: "memory.shared.forget",
                        scope,
                        id: draft.id,
                        revision: draft.revision,
                      });
                    }}
                  >
                    忘记
                  </Button>
                )}
                <Button
                  variant="primary"
                  type="submit"
                  isDisabled={
                    busy ||
                    blocked ||
                    (!pending && (!draft.topic.trim() || !draft.content.trim()))
                  }
                >
                  {busy ? "保存中…" : pending ? "重试保存" : "保存记忆"}
                </Button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </section>
  );
}
