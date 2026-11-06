import type { PluginStorage } from "../tools/plugins.js";
import type { ValidatedAvatar } from "../../avatars/image.js";
import type { Command } from "../../shared/commands.js";
import type { CommandResult } from "../../shared/core.js";
import type { Quote } from "../../shared/chat/conversations.js";
import type { Run } from "../../shared/chat/runs.js";
import type { AvatarStorage } from "../chat/avatars.js";
import type { BotStorage } from "../chat/bots.js";
import type { ConversationStorage } from "../chat/conversations.js";
import type { DeletionStorage } from "../deletions/deletions.js";
import type { GroupStorage } from "../chat/groups.js";
import type { MemoryJobStorage } from "../memory/memory-jobs.js";
import type { MemoryStorage } from "../memory/memory.js";
import type { MessageStorage } from "../chat/messages.js";
import type { QuestionStorage } from "../tools/questions.js";
import type { RoutineService } from "../../routines/service.js";
import type { SharedMemoryStorage } from "../memory/shared-memory.js";
import type { SidebarSectionStorage } from "../chat/sidebar-sections.js";
import type { SkillStorage } from "../tools/skills.js";
import type { TemplateToolStorage } from "../templates/template-tools.js";
import type { TemplateStorage } from "../templates/templates.js";
import type { ToolCallStorage } from "../tools/tool-calls.js";

/**
 * Dependencies a command handler may use while Store holds the transaction.
 * Handlers return before commit and must not start their own transactions.
 */
export type CommandContext = {
  bots: Pick<
    BotStorage,
    | "read"
    | "create"
    | "update"
    | "preferences"
    | "copy"
    | "saveCharacter"
    | "saveImage"
  >;
  conversations: Pick<
    ConversationStorage,
    | "create"
    | "update"
    | "markRead"
    | "markUnread"
    | "saveDraft"
    | "saveReply"
    | "selectSkills"
    | "removeAttachment"
    | "grantDirectory"
    | "revokeDirectory"
  >;
  messages: Pick<
    MessageStorage,
    "enqueueMessage" | "send" | "prompt" | "cancel" | "retry" | "react"
  >;
  dataPath: string;
  /** Set for Store.execute. Other callers leave it unset. */
  requestId: string | undefined;
  /** Set only after the image was decoded before the transaction. */
  validatedAvatar: ValidatedAvatar | undefined;
  groups: GroupStorage;
  routines: RoutineService;
  templates: TemplateStorage;
  plugins: Pick<PluginStorage, "list">;
  templateTools: TemplateToolStorage;
  avatars: AvatarStorage;
  skills: SkillStorage;
  memory: MemoryStorage;
  memoryJobs: MemoryJobStorage;
  sharedMemory: SharedMemoryStorage;
  toolCalls: ToolCallStorage;
  questions: QuestionStorage;
  deletions: DeletionStorage;
  sidebar: SidebarSectionStorage;
  requireBot(id: string): void;
  requireConversation(id: string): { botId: string };
  createConversation(botId: string, hidden?: boolean): string;
  skillOwners(conversationId: string): string[];
  enqueueRoutine(
    botId: string,
    text: string,
  ): { id: string; conversationId: string };
  quote(conversationId: string, messageId: string): Quote;
  getRun(id: string): Run | undefined;
  changed(): void;
  canonicalPath(path: string): string;
};

export type CommandHandler = (
  command: Command,
  ctx: CommandContext,
) => CommandResult;

export type CommandHandlers = {
  [K in Command["type"]]: CommandHandler;
};

/** Registry lookup is correlated; this rejects a handler registered under the wrong type. */
export function commandOf<T extends Command["type"]>(
  command: Command,
  type: T,
): asserts command is Extract<Command, { type: T }> {
  if (command.type !== type) throw new Error(`命令分派不一致：${command.type}`);
}

export function handle<T extends Command["type"]>(
  type: T,
  run: (
    command: Extract<Command, { type: T }>,
    ctx: CommandContext,
  ) => CommandResult,
): CommandHandler {
  return (command, ctx) => {
    commandOf(command, type);
    return run(command, ctx);
  };
}
