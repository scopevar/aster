import { IconButton } from "../../components/icon-button.js";
import { Input, TextArea, Button } from "@heroui/react";
import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useState } from "react";
import type { Bot } from "../../../shared/chat/bots.js";
import type { CommandResult } from "../../../shared/core.js";
import type { Conversation } from "../../../shared/chat/conversations.js";
import { type useAttachments } from "../files/attachments.js";
import { errorMessage } from "../../lib/client.js";
import { GroupDraftView } from "./group-draft-view.js";
import { Avatar, Icon } from "../../components/icons.js";
import { useGroupDraft } from "./use-group-draft.js";
import { SettingsSelect } from "../../components/settings/settings-controls.js";
export function GroupAvatar({
  small = false,
  members,
}: {
  small?: boolean;
  members: Bot[];
}) {
  return (
    <span className={`group-avatar ${small ? "small" : ""}`} aria-hidden="true">
      <span className="group-person">本</span>
      {members.slice(0, 2).map((bot) => (
        <Avatar
          key={bot.id}
          small
          botId={bot.id}
          appearance={bot.avatar}
          name={bot.name}
        />
      ))}
    </span>
  );
}
export function GroupDraft({
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
  const model = useGroupDraft({
    bots,
    onClose,
    onCreated,
    act,
    conversations,
    uploads,
  });
  return <GroupDraftView {...model} />;
}
export function GroupDetails({
  conversation,
  bots,
  view,
  act,
  onOpenBot,
  onMemory,
  onOpenRoutines,
}: {
  conversation: Conversation;
  bots: Bot[];
  view: "overview" | "settings";
  act(command: Command): Promise<CommandResult | undefined>;
  onOpenBot(id: string): void;
  onMemory(id: string): void;
  onOpenRoutines(botId: string): void;
}) {
  const group = conversation.group;
  const [draft, setDraft] = useState(group),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!group || !draft) return null;
  const save = async (next: typeof draft) => {
    setBusy(true);
    setError("");
    try {
      const result = await act({
        type: "group.update",
        conversationId: conversation.id,
        ...next,
      });
      if (!result) throw Error("保存未确认，请检查提示后重试。");
      setDraft({ ...next, revision: next.revision + 1 });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className={`details group-details ${view}`} aria-label="群聊详情">
      {view === "settings" ? (
        <>
          <div className="settings-avatar">
            <GroupAvatar
              members={group.memberIds.flatMap((id) =>
                bots.filter((b) => b.id === id),
              )}
            />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save(draft);
            }}
          >
            <label>
              名称
              <Input
                variant="secondary"
                aria-label="群组名称"
                value={draft.name}
                maxLength={160}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              描述
              <TextArea
                variant="secondary"
                aria-label="群组描述"
                value={draft.description}
                maxLength={4000}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
            </label>
            <label>
              主持人
              <SettingsSelect
                label="群聊主持人"
                value={draft.hostBotId ?? "none"}
                disabled={busy}
                options={[
                  { value: "none", label: "无主持人 · 轮流讨论" },
                  ...group.memberIds.map((id) => ({
                    value: id,
                    label: bots.find((bot) => bot.id === id)?.name ?? "成员",
                  })),
                ]}
                onChange={(id) =>
                  setDraft({ ...draft, hostBotId: id === "none" ? null : id })
                }
              />
            </label>
            <Button
              variant="secondary"
              size="sm"
              type="submit"
              className="secondary"
              isDisabled={busy || !draft.name.trim()}
            >
              保存群设置
            </Button>
          </form>
        </>
      ) : (
        <>
          <p className="muted">成员</p>
          <ul className="group-members">
            {group.memberIds.map((id) => {
              const bot = bots.find((b) => b.id === id);
              return (
                <li key={id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenBot(id)}
                  >
                    {bot && (
                      <Avatar
                        small
                        botId={bot.id}
                        appearance={bot.avatar}
                        name={bot.name}
                      />
                    )}
                    {bot?.name ?? "未知成员"}
                    {group.hostBotId === id && (
                      <span className="muted small-text">主持人</span>
                    )}
                  </Button>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    className="icon-button"
                    isDisabled={busy || group.memberIds.length === 1}
                    aria-label={`移除 ${bot?.name ?? "成员"}`}
                    onClick={() => {
                      void save({
                        ...group,
                        hostBotId:
                          group.hostBotId === id ? null : group.hostBotId,
                        memberIds: group.memberIds.filter(
                          (member) => member !== id,
                        ),
                      });
                    }}
                  >
                    <Icon name="close" size={14} />
                  </IconButton>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="group-member-memory"
                    aria-label={`查看 ${bot?.name ?? "成员"} 的群聊记忆`}
                    onClick={() => onMemory(id)}
                  >
                    记忆
                  </Button>
                </li>
              );
            })}
          </ul>
          <div className="group-add-members">
            {bots
              .filter((b) => !group.memberIds.includes(b.id))
              .map((bot) => (
                <Button
                  variant="ghost"
                  size="sm"
                  key={bot.id}
                  isDisabled={busy || group.memberIds.length >= 8}
                  onClick={() => {
                    void save({
                      ...group,
                      memberIds: [...group.memberIds, bot.id],
                    });
                  }}
                >
                  <Icon name="plus" size={14} />
                  {bot.name}
                </Button>
              ))}
          </div>
          {group.memberIds.length === bots.length && (
            <p className="muted small-text">创建更多 Bot 后即可添加到这里。</p>
          )}
          <div className="routine-empty">
            <p>
              例行任务属于各个成员。打开后管理的是该 Bot 自己的定时任务和
              Webhook。
            </p>
            {group.memberIds.map((id) => {
              const member = bots.find((item) => item.id === id);
              return (
                <Button
                  variant="secondary"
                  size="sm"
                  key={id}
                  className="secondary"
                  type="button"
                  onClick={() => onOpenRoutines(id)}
                >
                  管理 {member?.name ?? "成员"} 的例行任务
                </Button>
              );
            })}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </aside>
  );
}
