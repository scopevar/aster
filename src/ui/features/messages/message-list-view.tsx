import { Disclosure } from "../../components/disclosure.js";
import { Button } from "@heroui/react";
import { pluginCallText } from "../../../presentation/plugin-text.js";
import { routineScheduleText } from "../../../presentation/routine-schedule.js";
import { PluginCallCard } from "./plugin-call-card.js";
import { ReplyLoading } from "./message-activity-view.js";
import { PendingMessage } from "./pending-message.js";
import { questionText } from "../../../shared/chat/questions.js";
import { computerToolText, toolText } from "../../../presentation/tool-text.js";
import { AttachmentList } from "../files/attachments.js";
import { avatarPaint } from "../../components/avatar/avatar.js";
import { desktop } from "../../lib/client.js";
import { ComputerToolCard } from "./computer-tool.js";
import { DocumentCard } from "../files/document-card.js";
import { EmojiPicker } from "../../components/emoji-picker.js";
import { Avatar, Icon } from "../../components/icons.js";
import "./message-markdown.css";
import { MessageMarkdown } from "./message-markdown.js";
import { statusLabel } from "../../lib/run-status.js";
import { QuestionCard } from "./question-card.js";
import { TemplateCard } from "../templates/template-card.js";
import { ToolCard } from "./tool-card.js";
import type { MessageListViewModel } from "./use-message-list.js";
import { MessageSendStatus } from "./message-send-status.js";

export function MessageListView({
  messages,
  pendingMessages,
  sendFeedback,
  retrySend,
  runs,
  hasOlder,
  hasNewer,
  historical,
  focusedMessageId,
  onLatest,
  act,
  recentEmojis,
  botName,
  groupBots,
  timeZone,
  onOpenAttachment,
  onReply,
  onOpenSkill,
  onOpenRoutines,
  onOpenTemplates,
  onOpenGroupMember,
  ref,
  atBottom,
  menu,
  setMenu,
  closeMenu,
  pending,
  loadPage,
  retrying,
  setRetrying,
  workingMember,
  activity,
}: MessageListViewModel) {
  return (
    <div
      ref={ref}
      className="messages"
      onScroll={() => {
        const el = ref.current;
        if (el)
          atBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {historical && (
        <div className="history-navigation">
          <span>正在查看历史消息</span>
          <Button
            variant="secondary"
            size="sm"
            className="secondary"
            onClick={onLatest}
          >
            返回最新消息
          </Button>
        </div>
      )}
      {hasOlder && (
        <Button
          variant="ghost"
          size="sm"
          className="load-older"
          isDisabled={pending}
          onClick={() => void loadPage("before")}
        >
          加载更早消息
        </Button>
      )}
      {messages.map((message, index) => {
        const member = groupBots?.find((b) => b.id === message.botId);
        const sender = member?.name ?? botName;
        const recorded = runs.find((r) => r.id === message.runId);
        const feedback = sendFeedback.get(message.id);
        const run = recorded ?? {
          status: message.runStatus,
          error: message.runError,
        };
        const canRetry =
          message.role === "user" &&
          recorded?.status === "failed" &&
          recorded.groupTurns.length === 0;
        return (
          <div
            key={message.id}
            data-message-id={message.id}
            className={
              focusedMessageId === message.id ? "focused-message" : undefined
            }
          >
            {(index === 0 ||
              message.createdAt - (messages[index - 1]?.createdAt ?? 0) >
                30 * 60 * 1000) && (
              <time
                className="date-label"
                dateTime={new Date(message.createdAt).toISOString()}
              >
                {new Intl.DateTimeFormat("zh-CN", {
                  ...(timeZone === "auto" ? {} : { timeZone }),
                  month: "long",
                  day: "numeric",
                  weekday: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                }).format(message.createdAt)}
              </time>
            )}
            <article
              className={`message ${message.role} ${groupBots && message.role === "assistant" ? "group-response" : ""} ${index > 0 && messages[index - 1]?.role !== message.role ? "new-speaker" : ""}`}
              aria-label={`${message.role === "user" ? "你" : sender} ${new Date(message.createdAt).toLocaleTimeString("zh-CN")}`}
            >
              {groupBots && message.role === "assistant" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="group-message-sender"
                  {...(member
                    ? { style: { color: avatarPaint[member.avatar.color] } }
                    : {})}
                  isDisabled={!member}
                  onClick={() => {
                    if (member) onOpenGroupMember(member.id);
                  }}
                  aria-label={`打开 ${sender} 的聊天`}
                >
                  {sender}
                </Button>
              )}
              <div
                className="message-body"
                tabIndex={0}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({
                    id: message.id,
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
                    setMenu({ id: message.id, anchor: event.currentTarget });
                  }
                }}
              >
                {message.role === "user" &&
                  message.sendStatus === "pending" && (
                    <MessageSendStatus
                      status={feedback?.status ?? "sending"}
                      startedAt={feedback?.startedAt ?? message.createdAt}
                      error={feedback?.error}
                      onRetry={
                        feedback ? () => retrySend(message.id) : undefined
                      }
                    />
                  )}
                {groupBots && message.role === "assistant" && member && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="group-reply-avatar"
                    aria-label={`通过头像打开 ${sender} 的聊天`}
                    onClick={() => onOpenGroupMember(member.id)}
                  >
                    <Avatar
                      small
                      botId={member.id}
                      appearance={member.avatar}
                      name={member.name}
                    />
                  </Button>
                )}
                {message.skills.length > 0 && (
                  <div className="skill-chips">
                    {message.skills.map((skill) => (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="skill-chip"
                        key={skill.id}
                        onClick={() => onOpenSkill(skill)}
                      >
                        <Icon name="skill" size={13} /> {skill.name} · v
                        {skill.revision}
                      </Button>
                    ))}
                  </div>
                )}
                {message.attachments.length > 0 && (
                  <AttachmentList
                    attachments={message.attachments}
                    onOpen={onOpenAttachment}
                  />
                )}
                {message.replyTo && (
                  <blockquote className="message-quote">
                    <Icon name="reply" size={13} />
                    <span>{message.replyTo.text}</span>
                  </blockquote>
                )}
                {message.routine ? (
                  <div className="bubble routine-receipt">
                    <strong>{message.text}</strong>
                    <p>
                      保存时版本 v{message.routine.routine.revision} ·{" "}
                      {message.routine.routine.state === "deleted"
                        ? "已删除"
                        : message.routine.routine.state === "active"
                          ? "已启用"
                          : "已暂停"}
                    </p>
                    <p>
                      {routineScheduleText(message.routine.routine.schedule)}
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onPress={() => onOpenRoutines(message.botId)}
                    >
                      查看并管理任务
                    </Button>
                  </div>
                ) : message.template ? (
                  <TemplateCard
                    receipt={message.template}
                    onOpen={onOpenTemplates}
                  />
                ) : message.document ? (
                  <DocumentCard call={message.document} />
                ) : message.question ? (
                  <QuestionCard question={message.question} />
                ) : message.pluginCall ? (
                  <PluginCallCard call={message.pluginCall} />
                ) : message.computerTool ? (
                  <ComputerToolCard tool={message.computerTool} />
                ) : message.tool ? (
                  <ToolCard tool={message.tool} />
                ) : message.text ? (
                  <div className="bubble message-text">
                    <MessageMarkdown text={message.text} />
                  </div>
                ) : null}
                <time
                  className="message-time"
                  dateTime={new Date(message.createdAt).toISOString()}
                >
                  {new Date(message.createdAt).toLocaleString("sv-SE", {
                    ...(timeZone === "auto" ? {} : { timeZone }),
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false,
                  })}
                </time>
              </div>
              {menu?.id === message.id && (
                <EmojiPicker
                  anchor={menu.anchor}
                  point={menu.point}
                  actions={[
                    {
                      label: "回复",
                      icon: "reply",
                      run: () => onReply(message),
                    },
                    {
                      label: "复制",
                      icon: "copy",
                      run: () =>
                        desktop.copyText(
                          message.question
                            ? questionText(message.question)
                            : message.pluginCall
                              ? pluginCallText(message.pluginCall)
                              : message.computerTool
                                ? computerToolText(message.computerTool)
                                : message.tool
                                  ? toolText(message.tool)
                                  : message.text,
                        ),
                    },
                    {
                      label: "复制请求 ID",
                      icon: "copy",
                      run: () => desktop.copyText(message.runId),
                    },
                  ]}
                  recent={recentEmojis}
                  selected={message.reactions
                    .filter((r) => r.mine)
                    .map((r) => r.emoji)}
                  onClose={closeMenu}
                  onSelect={async (emoji) =>
                    !!(await act({
                      type: "reaction.set",
                      messageId: message.id,
                      emoji,
                      active: !message.reactions.some(
                        (r) => r.emoji === emoji && r.mine,
                      ),
                    }))
                  }
                />
              )}
              {message.reactions.length > 0 && (
                <div className="reactions">
                  {message.reactions.map((r) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      key={r.emoji}
                      className={r.mine ? "mine" : ""}
                      aria-label={`${r.emoji} ${r.count}`}
                      aria-pressed={r.mine}
                      onClick={() => {
                        void act({
                          type: "reaction.set",
                          messageId: message.id,
                          emoji: r.emoji,
                          active: !r.mine,
                        });
                      }}
                    >
                      {r.emoji}
                      {r.count > 1 ? r.count : ""}
                    </Button>
                  ))}
                </div>
              )}
              {message.role === "user" &&
                message.sendStatus !== "pending" &&
                run &&
                run.status !== "completed" &&
                run.status !== "queued" &&
                run.status !== "running" && (
                  <div
                    className={`run-feedback ${run.error ? "has-error" : ""}`}
                    role="status"
                  >
                    <div className="run-feedback-heading">
                      <small className={`run-state ${run.status}`}>
                        {statusLabel[run.status]}
                      </small>
                      {canRetry && (
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          className="retry-run"
                          aria-label="重试这次失败的运行"
                          isDisabled={retrying === message.runId}
                          onClick={() => {
                            setRetrying(message.runId);
                            void act({
                              type: "run.retry",
                              runId: message.runId,
                            }).finally(() => setRetrying(null));
                          }}
                        >
                          重试
                        </Button>
                      )}
                    </div>
                    {run.error && (
                      <p className="run-feedback-error">{run.error}</p>
                    )}
                  </div>
                )}
              {message.role === "user" &&
              groupBots &&
              runs.find((r) => r.id === message.runId)?.groupTurns.length ? (
                <Disclosure className="group-turns" title={<>成员执行记录</>}>
                  {runs
                    .find((r) => r.id === message.runId)
                    ?.groupTurns.map((turn) => (
                      <p key={turn.ordinal}>
                        <span>
                          {groupBots.find((b) => b.id === turn.botId)?.name} ·{" "}
                          {turn.status === "skipped"
                            ? "跳过发言"
                            : statusLabel[turn.status]}
                        </span>
                        {turn.error && <small>{turn.error}</small>}
                      </p>
                    ))}
                </Disclosure>
              ) : null}
            </article>
          </div>
        );
      })}
      {pendingMessages.map((message) => (
        <PendingMessage
          key={message.id}
          message={message}
          onRetry={() => retrySend(message.id)}
        />
      ))}
      {activity?.loading && (
        <ReplyLoading
          name={workingMember?.name ?? botName}
          member={workingMember}
        />
      )}
      {hasNewer && (
        <Button
          variant="ghost"
          size="sm"
          className="load-older"
          isDisabled={pending}
          onClick={() => void loadPage("after")}
        >
          加载更新消息
        </Button>
      )}
    </div>
  );
}
