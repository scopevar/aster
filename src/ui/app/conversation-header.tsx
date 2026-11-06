import { IconButton } from "../components/icon-button.js";
import { Tooltip } from "../components/tooltip.js";
import { Button } from "@heroui/react";
import type { ConversationViewModel } from "../features/conversations/use-conversation-session.js";
import type { AppOverlayViewModel } from "./use-app-overlays.js";
import type { ConversationCommandsViewModel } from "../features/conversations/use-conversation-commands.js";
import { GroupAvatar } from "../features/conversations/groups.js";
import { Avatar, Icon } from "../components/icons.js";
import { TemplateActions } from "../features/templates/template-actions.js";

export function ConversationHeader({
  state,
  select,
  bot,
  setDetails,
  details,
  conversation,
  setModal,
  newChatTarget,
  newChatReturn,
  setDetailsView,
  setHistoryWindow,
  setTemplateDraftId,
  detailsView,
  onOpenRoutines,
  openingRoutines,
}: Pick<
  ConversationViewModel & AppOverlayViewModel & ConversationCommandsViewModel,
  | "state"
  | "select"
  | "bot"
  | "setDetails"
  | "details"
  | "conversation"
  | "setModal"
  | "newChatTarget"
  | "newChatReturn"
  | "setDetailsView"
  | "setHistoryWindow"
  | "setTemplateDraftId"
  | "detailsView"
> & {
  onOpenRoutines(botId: string): void;
  openingRoutines: boolean;
}) {
  return (
    <header
      className={`conversation-header ${!bot ? "new-conversation-header" : ""}`}
    >
      {bot ? (
        <Button
          variant="ghost"
          size="sm"
          className="conversation-title"
          onClick={() => setDetails(!details)}
        >
          {conversation?.group ? (
            <GroupAvatar
              small
              members={conversation.group.memberIds.flatMap((id) =>
                state.bots.filter((b) => b.id === id),
              )}
            />
          ) : (
            <Avatar
              small
              botId={bot.id}
              appearance={bot.avatar}
              name={bot.name}
            />
          )}
          <strong>{bot.name}</strong>
        </Button>
      ) : (
        <div className="recipient">
          <span>新会话</span>
        </div>
      )}
      {bot && <span className="conversation-kind">Agent</span>}
      <div className="drag-region" />
      {!bot && newChatTarget && (
        <Tooltip content="关闭新聊天">
          <Button
            variant="ghost"
            size="sm"
            className="icon-button"
            aria-label="关闭新聊天"
            onClick={() => {
              const previous = newChatReturn.current;
              select(newChatTarget.id);
              if (previous) {
                setDetails(previous.details);
                setDetailsView(previous.view);
              }
            }}
          >
            <Icon name="close" size={16} />
          </Button>
        </Tooltip>
      )}
      {bot && conversation && !conversation.group && (
        <TemplateActions
          key={conversation.id}
          conversationId={conversation.id}
          onRequested={() => {
            setHistoryWindow(null);
          }}
          onManage={() => {
            setTemplateDraftId(undefined);
            setModal("templates");
          }}
        />
      )}
      {bot && conversation && !conversation.group && !details && (
        <IconButton
          variant="ghost"
          size="sm"
          aria-label="管理本地插件"
          onPress={() => setModal("plugins")}
        >
          <Icon name="skill" size={18} />
        </IconButton>
      )}
      {bot && conversation && !conversation.group && !details && (
        <IconButton
          variant="ghost"
          size="sm"
          aria-label="查看并管理任务"
          isPending={openingRoutines}
          onPress={() => onOpenRoutines(bot.id)}
        >
          <Icon name="clock" size={18} />
        </IconButton>
      )}
      {bot && !details && conversation?.group && (
        <IconButton
          variant="ghost"
          size="sm"
          aria-label="群聊详情"
          aria-expanded={details}
          onPress={() => setDetails(!details)}
        >
          <Icon name="info" size={18} />
        </IconButton>
      )}
      {details && bot && (
        <div className="details-heading">
          {detailsView === "settings" ? (
            <>
              <IconButton
                variant="ghost"
                size="sm"
                className="back-icon"
                aria-label="返回 Bot 概览"
                onPress={() => setDetailsView("overview")}
              >
                <Icon name="chevron" size={16} />
              </IconButton>
              <strong>设置</strong>
            </>
          ) : (
            <IconButton
              variant="ghost"
              size="sm"
              aria-label="Bot 设置"
              onPress={() => setDetailsView("settings")}
            >
              <Icon name="settings" size={16} />
            </IconButton>
          )}
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="收起 Bot 详情"
            onPress={() => setDetails(false)}
          >
            <Icon name="collapse" size={18} />
          </IconButton>
        </div>
      )}
    </header>
  );
}
