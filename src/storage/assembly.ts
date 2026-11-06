import { RoutineRepository } from "../routines/repository.js";
import { enqueueMessage } from "./commands/messages.js";
import { PluginStorage } from "./tools/plugins.js";
import { PluginCallStorage } from "./tools/plugin-calls.js";
import { quoteText } from "../presentation/message-text.js";
import { RoutineTools } from "../routines/tool.js";
import { RoutineOperations } from "../routines/operations.js";
import type { DatabaseSync } from "node:sqlite";
import type { ValidatedAvatar } from "../avatars/image.js";
import type { Skill } from "../shared/tools/skills.js";
import { AvatarStorage } from "./chat/avatars.js";
import { BotStorage } from "./chat/bots.js";
import type { CommandContext } from "./commands/context.js";
import { ConversationStorage } from "./chat/conversations.js";
import { ConversationContextStorage } from "./chat/conversation-context.js";
import { DeletionOperations } from "./deletions/deletion-operations.js";
import { DeletionStorage } from "./deletions/deletions.js";
import { DocumentOperations } from "./documents/document-operations.js";
import { DocumentStorage } from "./documents/documents.js";
import { FileStorage } from "./documents/file-storage.js";
import { GroupStorage } from "./chat/groups.js";
import { HistoryStorage } from "./chat/history.js";
import { MemoryJobStorage } from "./memory/memory-jobs.js";
import { MemoryOperations } from "./memory/memory-operations.js";
import { MemoryStorage } from "./memory/memory.js";
import { MessageStorage } from "./chat/messages.js";
import { UserNoticeStorage } from "./chat/notices.js";
import { QuestionStorage } from "./tools/questions.js";
import { RoutineService } from "../routines/service.js";
import { RunStorage } from "./runs/runs.js";
import { SharedMemoryStorage } from "./memory/shared-memory.js";
import { SidebarSectionStorage } from "./chat/sidebar-sections.js";
import { SkillToolStorage } from "./tools/skill-tools.js";
import { SkillStorage } from "./tools/skills.js";
import { SnapshotReader } from "./snapshot-reader.js";
import type { Store } from "./store.js";
import { TemplateImporter } from "./templates/template-importer.js";
import { TemplateOperations } from "./templates/template-operations.js";
import { TemplateToolStorage } from "./templates/template-tools.js";
import { TemplateStorage } from "./templates/templates.js";
import { ToolCallStorage } from "./tools/tool-calls.js";
import { ToolOperations } from "./tools/tool-operations.js";
type Owner = {
  transaction<T>(fn: () => T): T;
  changed(): void;
  requireBot(id: string): void;
  requireConversation(id: string): { botId: string };
  fingerprint(body: string): string;
  cursor: Store["cursor"];
  skillOwners(id: string): string[];
  messageSkills(id: string): Skill[];
  createConversation(botId: string, hidden?: boolean): string;
  commandContext(
    requestId?: string,
    validatedAvatar?: ValidatedAvatar,
  ): CommandContext;
};
/** Builds domain capabilities over one connection; callbacks defer cyclic dependencies until use. */
export function createStorageModules(db: DatabaseSync, owner: Owner) {
  const bots = new BotStorage(db);
  const conversations = new ConversationStorage(db);
  const messages = new MessageStorage(db);
  const groups = new GroupStorage(db);
  const notices = new UserNoticeStorage(db);
  const routines = new RoutineService(new RoutineRepository(db), notices);
  const templates = new TemplateStorage(db);
  const templateTools = new TemplateToolStorage(db, templates);
  const avatars = new AvatarStorage(db);
  const skills = new SkillStorage(db);
  const plugins = new PluginStorage(db, skills, owner);
  const pluginCalls = new PluginCallStorage(
    db,
    {
      ...owner,
      canWrite: (job) =>
        runs.canWrite(job) && runs.getRun(job.id)?.status === "running",
    },
    notices,
  );
  const memory = new MemoryStorage(db);
  const memoryJobs = new MemoryJobStorage(db, memory);
  const sharedMemory = new SharedMemoryStorage(db);
  const toolCalls = new ToolCallStorage(db);
  const questions = new QuestionStorage(db);
  const skillTools = new SkillToolStorage(db, skills);
  const deletions = new DeletionStorage(db);
  const sidebar = new SidebarSectionStorage(db);
  const documents = new DocumentStorage(db);
  const history: HistoryStorage = new HistoryStorage(
    db,
    (conversationId, messageId) => ({
      text: runs.quote(conversationId, messageId).text,
      attachments: files.listAttachments(conversationId, messageId),
    }),
  );
  const views = new SnapshotReader(db, {
    pluginCalls,
    skills: skills,
    groups: groups,
    deletions: deletions,
    sidebar: sidebar,
    routines: routines,
    templateTools: templateTools,
    toolCalls: toolCalls,
    questions: questions,
    documents: documents,
    cursor: () => owner.cursor(),
    listAttachments: (conversationId, messageId) =>
      files.listAttachments(conversationId, messageId),
    quote: (conversationId, messageId) => runs.quote(conversationId, messageId),
    skillOwners: (conversationId) => owner.skillOwners(conversationId),
    messageSkills: (messageId) => owner.messageSkills(messageId),
  });
  const files = new FileStorage(db, {
    transaction: owner.transaction,
    requireConversation: owner.requireConversation,
    changed: owner.changed,
    canWrite: (...args: Parameters<RunStorage["canWrite"]>) =>
      runs.canWrite(...args),
    getRun: (...args: Parameters<RunStorage["getRun"]>) => runs.getRun(...args),
    fingerprint: owner.fingerprint,
  });
  const runs: RunStorage = new RunStorage(db, {
    pluginCalls,
    quoteText,
    listAttachments: (...args: Parameters<FileStorage["listAttachments"]>) =>
      files.listAttachments(...args),
    toolCalls: toolCalls,
    questions: questions,
    messageSkills: owner.messageSkills,
    transaction: owner.transaction,
    changed: owner.changed,
    groups: groups,
    deletions: deletions,
    history: history,
    documents: documents,
    memoryJobs: memoryJobs,
    routines: routines,
  });
  const conversationContext = new ConversationContextStorage(db, {
    transaction: owner.transaction,
    canWrite: (job) => runs.canWrite(job),
  });
  const routineOperations = new RoutineOperations({
    routines,
    transaction: owner.transaction,
    changed: owner.changed,
    requireBot: owner.requireBot,
    createConversation: owner.createConversation,
    enqueueMessage: (conversationId, text) =>
      enqueueMessage(owner.commandContext(), {
        type: "message.send",
        conversationId,
        text,
      }),
  });
  const templateImporter = new TemplateImporter(db, {
    templates,
    templateTools,
    fingerprint: owner.fingerprint,
    transaction: owner.transaction,
    avatars: avatars,
    skills: skills,
    routines: routines,
    enqueueRoutine: routineOperations.enqueue,
    createConversation: owner.createConversation,
    changed: owner.changed,
  });
  const toolOperations = new ToolOperations({
    transaction: owner.transaction,
    canWrite: (...args: Parameters<RunStorage["canWrite"]>) =>
      runs.canWrite(...args),
    getRun: (...args: Parameters<RunStorage["getRun"]>) => runs.getRun(...args),
    skillTools: skillTools,
    changed: owner.changed,
    routineTools: new RoutineTools({
      routines,
      messages,
      transaction: owner.transaction,
      changed: owner.changed,
      canWrite: (job) => runs.canWrite(job),
      getRun: (id) => runs.getRun(id),
      enqueue: routineOperations.enqueue,
    }),
    enqueueRoutine: routineOperations.enqueue,
    templateTools: templateTools,
    commandContext: owner.commandContext,
    questions: questions,
    toolCalls: toolCalls,
  });
  const documentOperations = new DocumentOperations({
    documents: documents,
    transaction: owner.transaction,
    changed: owner.changed,
    canWrite: (job) => runs.canWrite(job),
    getRun: (id) => runs.getRun(id),
  });
  const deletionOperations = new DeletionOperations({
    deletions: deletions,
    transaction: owner.transaction,
    changed: owner.changed,
  });
  const memoryOperations = new MemoryOperations({
    memory: memory,
    memoryJobs: memoryJobs,
    sharedMemory: sharedMemory,
    deletions: deletions,
    transaction: owner.transaction,
    changed: owner.changed,
  });
  const templateOperations = new TemplateOperations({ templates });
  return {
    plugins,
    pluginCalls,
    routineOperations,
    templateOperations,
    bots,
    conversations,
    messages,
    groups,
    routines,
    templates,
    templateTools,
    avatars,
    skills,
    memory,
    memoryJobs,
    sharedMemory,
    toolCalls,
    questions,
    skillTools,
    deletions,
    sidebar,
    documents,
    history,
    views,
    files,
    runs,
    conversationContext,
    templateImporter,
    toolOperations,
    documentOperations,
    deletionOperations,
    memoryOperations,
  };
}
