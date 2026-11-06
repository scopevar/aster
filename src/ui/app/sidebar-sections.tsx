import { IconButton } from "../components/icon-button.js";
import { Button } from "@heroui/react";
import { storedDesktopEnvelopeSchema as envelopeSchema } from "../../shared/desktop/desktop-commands.js";
import type { DesktopEnvelope as Envelope } from "../../shared/desktop/desktop-commands.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppError } from "../../shared/core.js";
import {
  type SectionCommand,
  type SidebarState,
} from "../../shared/chat/sidebar-sections.js";
import { envelope, errorMessage, execute } from "../lib/client.js";
import { ContextMenu } from "../components/context-menu.js";
import { Icon } from "../components/icons.js";
import { Modal } from "../components/modal.js";
import "./sidebar-sections.css";

const pendingKey = "sidebar-section-command";
function restore() {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
    if (raw === null) return { request: null, error: "" };
    const request = envelopeSchema.parse(raw);
    if (!request.command.type.startsWith("section."))
      throw new Error("command mismatch");
    return { request, error: "" };
  } catch {
    return {
      request: null,
      error: "上次分组操作记录无法读取。原记录已保留，请核实后再操作。",
    };
  }
}

/** One pending receipt survives renderer restart. Unknown outcomes are never issued with a new ID. */
export function useSectionCommands(refresh: () => Promise<void>) {
  const [initial] = useState(restore);
  const request = useRef<Envelope | null>(initial.request);
  const active = useRef(false);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(initial.error);
  const [unresolved, setUnresolved] = useState(!!initial.request);
  const run = async (command?: SectionCommand): Promise<boolean> => {
    if (active.current || initial.error) return false;
    if (command && request.current) {
      setError("上次分组操作尚未确认，请先重试核实。");
      return false;
    }
    active.current = true;
    setPending(true);
    setError("");
    try {
      if (command) request.current = envelope(command);
      if (!request.current) return false;
      localStorage.setItem(pendingKey, JSON.stringify(request.current));
      await execute(request.current);
      localStorage.removeItem(pendingKey);
      request.current = null;
      setUnresolved(false);
      await refresh();
      return true;
    } catch (error) {
      let cacheError = "";
      if (
        error instanceof AppError &&
        !["unknown", "unavailable"].includes(error.code)
      ) {
        try {
          localStorage.removeItem(pendingKey);
          request.current = null;
        } catch {
          cacheError = "本地请求记录清理失败。";
        }
      }
      setUnresolved(!!request.current);
      setError(errorMessage(error) + cacheError);
      try {
        await refresh();
      } catch {
        /* The visible command error remains; main view owns connection status. */
      }
      return false;
    } finally {
      active.current = false;
      setPending(false);
    }
  };
  return {
    run,
    pending,
    error,
    blocked: pending || unresolved || !!initial.error,
    notice:
      error || unresolved ? (
        <div className="section-error" role="alert">
          <span>{error || "上次分组操作尚未确认。"}</span>
          {unresolved && (
            <Button
              variant="ghost"
              size="sm"
              isDisabled={pending}
              onClick={() => void run()}
            >
              重试分组操作
            </Button>
          )}
        </div>
      ) : null,
  };
}

function SectionName({
  name,
  disabled,
  onSave,
  onCancel,
}: {
  name: string;
  disabled: boolean;
  onSave(value: string): Promise<boolean>;
  onCancel(): void;
}) {
  const [value, setValue] = useState(name);
  const input = useRef<HTMLInputElement>(null),
    busy = useRef(false),
    cancelled = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const save = async () => {
    if (busy.current || cancelled.current || disabled) return;
    if (!value.trim()) {
      input.current?.focus();
      return;
    }
    if (value.trim() === name) {
      cancelled.current = true;
      onCancel();
      return;
    }
    busy.current = true;
    try {
      if (await onSave(value.trim())) onCancel();
    } finally {
      busy.current = false;
    }
  };
  return (
    <input
      ref={input}
      aria-label="分组名称"
      maxLength={80}
      value={value}
      disabled={disabled}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          void save();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelled.current = true;
          onCancel();
        }
      }}
    />
  );
}

export function SectionedConversations<
  T extends { id: string; pinned: boolean; deletionPending: boolean },
>({
  state,
  conversations,
  collapsed,
  editing,
  setEditing,
  blocked,
  pending,
  error,
  run,
  renderRow,
  canAssign = () => true,
}: {
  state: SidebarState;
  conversations: T[];
  collapsed: boolean;
  editing: string | null;
  setEditing(id: string | null): void;
  blocked: boolean;
  pending: boolean;
  error: string;
  run(command: SectionCommand): Promise<boolean>;
  renderRow(conversation: T): ReactNode;
  canAssign?(conversation: T): boolean;
}) {
  const [menu, setMenu] = useState<{
    id: string;
    anchor: HTMLElement;
    point?: { x: number; y: number };
  } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null | undefined>(
    undefined,
  );
  const dragging = useRef<string | null>(null);
  const pinned = conversations.filter((conversation) => conversation.pinned);
  const rest = conversations.filter((conversation) => !conversation.pinned);
  const assigned = new Set(
    state.sections.flatMap((section) => section.conversationIds),
  );
  const sections = state.sections.map((section) => ({
    ...section,
    rows: rest.filter((conversation) =>
      section.conversationIds.includes(conversation.id),
    ),
  }));
  const unassigned = rest.filter(
    (conversation) => !assigned.has(conversation.id),
  );
  const rows = (values: T[]) =>
    values.map((conversation) => (
      <div
        key={conversation.id}
        className="section-conversation"
        draggable={
          !blocked && !conversation.deletionPending && canAssign(conversation)
        }
        onDragStart={(event) => {
          dragging.current = conversation.id;
          event.dataTransfer.setData(
            "application/x-aster-conversation",
            conversation.id,
          );
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          dragging.current = null;
          setDragOver(undefined);
        }}
      >
        {renderRow(conversation)}
      </div>
    ));
  const group = (
    id: string | null,
    name: string,
    folded: boolean,
    values: T[],
  ) => {
    if (collapsed && !values.length) return null;
    return (
      <section
        key={id ?? "unassigned"}
        className={`sidebar-section ${dragOver === id ? "drop-target" : ""}`}
        aria-label={name}
        onDragOver={(event) => {
          if (!dragging.current || blocked) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDragOver(id);
        }}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setDragOver(undefined);
        }}
        onDrop={(event) => {
          const conversationId = dragging.current;
          dragging.current = null;
          setDragOver(undefined);
          if (
            !conversationId ||
            blocked ||
            event.dataTransfer.getData("application/x-aster-conversation") !==
              conversationId
          )
            return;
          event.preventDefault();
          void run({
            type: "section.assign",
            revision: state.revision,
            id,
            conversationId,
          });
        }}
      >
        {!collapsed && (
          <div className="section-heading">
            {editing === id && id !== null ? (
              <SectionName
                key={id}
                name={name}
                disabled={blocked}
                onSave={(name) =>
                  run({
                    type: "section.rename",
                    revision: state.revision,
                    id,
                    name,
                  })
                }
                onCancel={() => setEditing(null)}
              />
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="section-title"
                aria-expanded={!folded}
                aria-label={`${folded ? "展开" : "折叠"} ${name}`}
                isDisabled={blocked}
                onClick={() =>
                  void run({
                    type: "section.fold",
                    revision: state.revision,
                    id,
                    collapsed: !folded,
                  })
                }
                onContextMenu={(event) => {
                  if (!id) return;
                  event.preventDefault();
                  setMenu({
                    id,
                    anchor: event.currentTarget,
                    point: { x: event.clientX, y: event.clientY },
                  });
                }}
              >
                <span>{name}</span>
                {folded && <small>{values.length}</small>}
                <i className={folded ? "" : "expanded"}>
                  <Icon name="chevron" size={12} />
                </i>
              </Button>
            )}
            {id && (
              <IconButton
                variant="ghost"
                size="sm"
                className="section-actions icon-button"
                aria-label={`${name} 分组操作`}
                isDisabled={blocked}
                onClick={(event) => {
                  if (event.currentTarget instanceof HTMLElement)
                    setMenu({ id, anchor: event.currentTarget });
                }}
              >
                <Icon name="more" size={14} />
              </IconButton>
            )}
          </div>
        )}
        {(collapsed || !folded) &&
          (values.length ? (
            rows(values)
          ) : (
            <p className="section-empty">将聊天拖到这里</p>
          ))}
      </section>
    );
  };
  const menuIndex = state.sections.findIndex(
    (section) => section.id === menu?.id,
  );
  const deleteSection = state.sections.find(
    (section) => section.id === deleting,
  );
  return (
    <>
      {rows(pinned)}
      {!state.sections.length ? (
        rows(rest)
      ) : (
        <>
          {sections.map((section) =>
            group(section.id, section.name, section.collapsed, section.rows),
          )}
          {unassigned.length > 0 &&
            group(null, "未分组", state.unassignedCollapsed, unassigned)}
        </>
      )}
      {menu && menuIndex >= 0 && (
        <ContextMenu
          anchor={menu.anchor}
          point={menu.point}
          onClose={() => setMenu(null)}
          actions={[
            {
              label: "重命名分组",
              icon: "edit",
              run: () => setEditing(menu.id),
            },
            {
              label: "上移",
              icon: "chevron",
              disabled: menuIndex === 0,
              run: async () => {
                const beforeId = state.sections[menuIndex - 1]?.id;
                if (beforeId)
                  await run({
                    type: "section.move",
                    revision: state.revision,
                    id: menu.id,
                    beforeId,
                  });
              },
            },
            {
              label: "下移",
              icon: "chevron",
              disabled: menuIndex === state.sections.length - 1,
              run: async () => {
                await run({
                  type: "section.move",
                  revision: state.revision,
                  id: menu.id,
                  beforeId: state.sections[menuIndex + 2]?.id ?? null,
                });
              },
            },
            {
              label: "删除分组",
              icon: "trash",
              destructive: true,
              separator: true,
              run: () => setDeleting(menu.id),
            },
          ]}
        />
      )}
      {deleteSection && (
        <Modal
          title={`删除“${deleteSection.name}”？`}
          variant="delete-confirm"
          onClose={() => {
            if (!pending) setDeleting(null);
          }}
          busy={pending}
          hideCloseButton
        >
          <p>此分组中的聊天将移至“未分组”。不会删除 Bot 或聊天记录。</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {blocked && !pending && (
            <p className="deletion-note">
              可以关闭此窗口，在侧栏重试核实原操作。
            </p>
          )}
          <footer>
            <Button
              variant="ghost"
              size="sm"
              isDisabled={pending}
              onClick={() => setDeleting(null)}
            >
              {blocked ? "关闭" : "取消"}
            </Button>
            <Button
              variant="danger"
              size="sm"
              className="destructive"
              isDisabled={blocked}
              onClick={() => {
                void run({
                  type: "section.delete",
                  revision: state.revision,
                  id: deleteSection.id,
                }).then((ok) => {
                  if (ok) setDeleting(null);
                });
              }}
            >
              删除分组
            </Button>
          </footer>
        </Modal>
      )}
    </>
  );
}
