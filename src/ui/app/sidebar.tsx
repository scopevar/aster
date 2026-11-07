import { IconButton } from "../components/icon-button.js";
import { Tooltip } from "../components/tooltip.js";
import { Button } from "@heroui/react";
import { useState } from "react";
import type { Bot } from "../../shared/chat/bots.js";
import type { Conversation } from "../../shared/chat/conversations.js";
import { Avatar, Icon } from "../components/icons.js";
import { ContextMenu } from "../components/context-menu.js";
import { GroupAvatar } from "../features/conversations/groups.js";
import type { SidebarState } from "../../shared/chat/sidebar-sections.js";
import {
  SectionedConversations,
  useSectionCommands,
} from "./sidebar-sections.js";
import { desktop } from "../lib/client.js";
import { conversationEntries } from "../features/conversations/conversation-entries.js";
import { SidebarToolbar } from "./sidebar-toolbar.js";
import { NavigationAccount } from "./navigation-account.js";
import { NavigationRail } from "./navigation-rail.js";

export function Sidebar({
  showConversations = true,
  activePage,
  onConversations,
  onMarket,
  sections,
  onRefresh,
  bots,
  conversations,
  selected,
  width,
  collapsed,
  onResize,
  onSelect,
  onSearch,
  onNewConversation,
  onNewBot,
  onCreateGroup,
  onSettings,
  onCheck,
  onUpdate,
  onUnread,
  onRename,
  onDelete,
}: {
  showConversations?: boolean;
  activePage: "conversations" | "market";
  onConversations(): void;
  onMarket(): void;
  sections: SidebarState;
  onRefresh(): Promise<void>;
  bots: Bot[];
  conversations: Conversation[];
  selected: string | null;
  width: number;
  collapsed: boolean;
  onResize(width: number, collapsed: boolean): void;
  onSelect(id: string | null): void;
  onSearch(): void;
  onNewConversation(): void;
  onNewBot(): void;
  onCreateGroup(): void;
  onSettings(tab: "通用"): void;
  onCheck(): void;
  onUpdate(
    c: Conversation,
    patch: Partial<Pick<Conversation, "hidden" | "pinned">>,
  ): Promise<unknown>;
  onUnread(c: Conversation): Promise<void>;
  onRename(c: Conversation): void;
  onDelete(c: Conversation): void;
}) {
  const sectionCommands = useSectionCommands(onRefresh);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [menu, setMenu] = useState<{
    conversation: Conversation;
    anchor: HTMLElement;
    point?: { x: number; y: number };
  } | null>(null);
  const update = async (
    patch: Partial<Pick<Conversation, "hidden" | "pinned">>,
  ) => {
    if (menu && !(await onUpdate(menu.conversation, patch)))
      throw new Error("操作未保存，请重试。");
  };
  const content = (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      {collapsed ? (
        <div className="sidebar-top">
          <IconButton
            variant="ghost"
            size="sm"
            className="icon-button"
            aria-label="新建会话"
            onClick={() => onSelect(null)}
          >
            <Icon name="plus" size={18} />
          </IconButton>
        </div>
      ) : (
        <SidebarToolbar
          onSearch={onSearch}
          onNewConversation={onNewConversation}
          onNewBot={onNewBot}
          onCreateGroup={onCreateGroup}
        />
      )}
      <nav className="bot-list" aria-label="会话">
        {sectionCommands.notice}
        <SectionedConversations
          state={sections}
          collapsed={collapsed}
          editing={editingSection}
          setEditing={setEditingSection}
          blocked={sectionCommands.blocked}
          pending={sectionCommands.pending}
          error={sectionCommands.error}
          run={sectionCommands.run}
          conversations={conversationEntries(
            conversations.filter(
              (c) => !c.group?.draft && (showHidden || !c.hidden),
            ),
          )}
          canAssign={(entry) => entry.kind === "agent"}
          renderRow={(entry) => {
            if (entry.kind !== "agent") return null;
            const c = entry.conversation;
            const source = bots.find((b) => b.id === c.botId);
            const identity =
              source && c.group ? { ...source, name: c.group.name } : source;
            if (!identity) return null;
            const unread = c.unreadCount > 0 || c.markedUnread;
            return (
              <Tooltip
                content={collapsed ? identity.name : undefined}
                key={c.id}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className={`bot-item ${selected === c.id ? "selected" : ""}`}
                  aria-description="Agent 会话"
                  isDisabled={c.deletionPending}
                  {...(collapsed ? { "aria-label": identity.name } : {})}
                  onClick={() => onSelect(c.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (
                      c.id.includes(":") ||
                      !(event.currentTarget instanceof HTMLElement)
                    )
                      return;
                    setMenu({
                      conversation: c,
                      anchor: event.currentTarget,
                      point: { x: event.clientX, y: event.clientY },
                    });
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.shiftKey && event.key === "F10") ||
                      event.key === "ContextMenu"
                    ) {
                      event.preventDefault();
                      if (
                        c.id.includes(":") ||
                        !(event.currentTarget instanceof HTMLElement)
                      )
                        return;
                      setMenu({ conversation: c, anchor: event.currentTarget });
                    }
                  }}
                >
                  <span className="sidebar-avatar">
                    {c.group ? (
                      <GroupAvatar
                        members={c.group.memberIds.flatMap((id) =>
                          bots.filter((b) => b.id === id),
                        )}
                      />
                    ) : (
                      <Avatar
                        name={identity.name}
                        botId={identity.id}
                        appearance={identity.avatar}
                      />
                    )}
                    {c.activityStatus ? (
                      <span
                        className="work-indicator"
                        role="status"
                        aria-label={
                          c.activityStatus === "queued"
                            ? "排队中"
                            : c.activityStatus === "cancelling"
                              ? "正在停止"
                              : "工作中"
                        }
                      >
                        ···
                      </span>
                    ) : unread ? (
                      <span
                        className="unread-indicator"
                        aria-label={`${c.unreadCount || 1} 条未读`}
                      >
                        {c.unreadCount > 1
                          ? c.unreadCount > 99
                            ? "99+"
                            : c.unreadCount
                          : ""}
                      </span>
                    ) : null}
                  </span>
                  {!collapsed && (
                    <>
                      <span className="sidebar-label">
                        <span className="conversation-label">
                          <strong>{identity.name}</strong>
                          <span
                            className="conversation-kind"
                            aria-hidden="true"
                          >
                            Agent
                          </span>
                        </span>
                        <small>
                          {c.deletionPending
                            ? "等待关联清理完成…"
                            : c.hidden
                              ? "已隐藏"
                              : c.preview}
                        </small>
                      </span>
                      {c.pinned && <Icon name="pin" size={12} />}
                    </>
                  )}
                </Button>
              </Tooltip>
            );
          }}
        />
      </nav>
      <div
        className="resize-handle"
        role="separator"
        aria-label="侧栏宽度"
        aria-orientation="vertical"
        aria-valuemin={88}
        aria-valuemax={400}
        aria-valuenow={collapsed ? 88 : width}
        aria-valuetext={collapsed ? "已折叠" : `${width} 像素`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            if (collapsed && e.key === "ArrowRight") onResize(width, false);
            else if (!collapsed && width <= 240 && e.key === "ArrowLeft")
              onResize(width, true);
            else if (!collapsed)
              onResize(
                Math.max(
                  240,
                  Math.min(400, width + (e.key === "ArrowRight" ? 8 : -8)),
                ),
                false,
              );
          }
          if (e.key === "Home") {
            e.preventDefault();
            onResize(width, true);
          }
          if (e.key === "End") {
            e.preventDefault();
            onResize(width, false);
          }
        }}
        onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            const left =
              e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
            const nextWidth = e.clientX - left;
            onResize(
              nextWidth < 160 ? width : Math.max(240, Math.min(400, nextWidth)),
              nextWidth < 160,
            );
          }
        }}
      />
      {menu && (
        <ContextMenu
          anchor={menu.anchor}
          point={menu.point}
          onClose={() => setMenu(null)}
          actions={[
            {
              label: menu.conversation.pinned ? "取消置顶" : "置顶",
              icon: "pin",
              run: () => update({ pinned: !menu.conversation.pinned }),
            },
            (() => {
              const create = async () => {
                const id = crypto.randomUUID();
                if (
                  await sectionCommands.run({
                    type: "section.create",
                    revision: sections.revision,
                    id,
                    name: "新分组",
                    conversationId: menu.conversation.id,
                  })
                )
                  setEditingSection(id);
              };
              return sections.sections.length
                ? {
                    label: "移至分组",
                    icon: "folder" as const,
                    disabled: sectionCommands.blocked,
                    children: [
                      ...sections.sections.map((section) => ({
                        label: section.name,
                        icon: "folder" as const,
                        checked: section.conversationIds.includes(
                          menu.conversation.id,
                        ),
                        run: async () => {
                          await sectionCommands.run({
                            type: "section.assign",
                            revision: sections.revision,
                            id: section.id,
                            conversationId: menu.conversation.id,
                          });
                        },
                      })),
                      {
                        label: "未分组",
                        icon: "folder" as const,
                        checked: !sections.sections.some((section) =>
                          section.conversationIds.includes(
                            menu.conversation.id,
                          ),
                        ),
                        run: async () => {
                          await sectionCommands.run({
                            type: "section.assign",
                            revision: sections.revision,
                            id: null,
                            conversationId: menu.conversation.id,
                          });
                        },
                      },
                      {
                        label: "移至新分组",
                        icon: "folder" as const,
                        separator: true,
                        run: create,
                      },
                    ],
                  }
                : {
                    label: "移至新分组",
                    icon: "folder" as const,
                    disabled: sectionCommands.blocked,
                    run: create,
                  };
            })(),
            {
              label: "标为未读",
              icon: "unread",
              run: () => onUnread(menu.conversation),
            },
            {
              label: menu.conversation.group ? "重命名群聊" : "重命名 Bot",
              icon: "edit",
              separator: true,
              run: () => onRename(menu.conversation),
            },
            {
              label: "复制对话 ID",
              icon: "copy",
              separator: true,
              run: () => desktop.copyText(menu.conversation.id),
            },
            {
              label: menu.conversation.hidden ? "在侧边栏显示" : "从侧边栏隐藏",
              icon: "hide",
              separator: true,
              run: () => update({ hidden: !menu.conversation.hidden }),
            },
            {
              label: "删除",
              icon: "trash",
              destructive: true,
              run: () => onDelete(menu.conversation),
            },
          ]}
        />
      )}
    </aside>
  );
  return (
    <>
      <NavigationRail
        active={activePage}
        onConversations={onConversations}
        onMarket={onMarket}
      >
        <NavigationAccount
          showHidden={showHidden}
          onSettings={onSettings}
          onHidden={() => setShowHidden(!showHidden)}
          onCheck={onCheck}
        />
      </NavigationRail>
      {showConversations && content}
    </>
  );
}
