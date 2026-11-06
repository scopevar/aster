import type { PendingMessageView } from "./pending-message.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import type { Attachment } from "../../../shared/files/attachments.js";
import type { Bot } from "../../../shared/chat/bots.js";
import type { CommandResult } from "../../../shared/core.js";
import type { Message } from "../../../shared/chat/messages.js";
import type { Run } from "../../../shared/chat/runs.js";
import type { SkillSummary } from "../../../shared/tools/skills.js";
import { MessageListView } from "./message-list-view.js";
import "./message-markdown.css";
import { useMessageList } from "./use-message-list.js";
export function Messages({
  messages,
  pendingMessages,
  retrySend,
  runs,
  hasOlder,
  hasNewer,
  historical,
  focusedMessageId,
  onOlder,
  onNewer,
  onLatest,
  act,
  recentEmojis,
  botName,
  groupBots,
  timeZone,
  onRead,
  onOpenAttachment,
  onReply,
  onOpenSkill,
  onOpenRoutines,
  onOpenTemplates,
  onOpenGroupMember,
}: {
  messages: Message[];
  pendingMessages: PendingMessageView[];
  retrySend(id: string): void;
  runs: Run[];
  hasOlder: boolean;
  hasNewer: boolean;
  historical: boolean;
  focusedMessageId: string | null;
  onOlder(): Promise<void>;
  onNewer(): Promise<void>;
  onLatest(): void;
  act(command: Command): Promise<CommandResult | undefined>;
  recentEmojis: string[];
  botName: string;
  groupBots?: Bot[] | undefined;
  timeZone: string;
  onRead(sequence: number): void;
  onOpenAttachment(file: Attachment): void;
  onReply(message: Message): Promise<void>;
  onOpenSkill(skill: SkillSummary): void;
  onOpenRoutines(botId: string): void;
  onOpenTemplates(id: string): void;
  onOpenGroupMember(id: string): void;
}) {
  const model = useMessageList({
    messages,
    pendingMessages,
    retrySend,
    runs,
    hasOlder,
    hasNewer,
    historical,
    focusedMessageId,
    onOlder,
    onNewer,
    onLatest,
    act,
    recentEmojis,
    botName,
    groupBots,
    timeZone,
    onRead,
    onOpenAttachment,
    onReply,
    onOpenSkill,
    onOpenRoutines,
    onOpenTemplates,
    onOpenGroupMember,
  });
  return <MessageListView {...model} />;
}
