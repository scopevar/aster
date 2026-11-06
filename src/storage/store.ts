import type { PluginStorage } from "./tools/plugins.js";
import type { PluginCallStorage } from "./tools/plugin-calls.js";
import type { RoutineOperations } from "../routines/operations.js";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { z } from "zod";
import type { ValidatedAvatar } from "../avatars/image.js";
import { type AvatarAccess } from "../shared/avatar.js";
import { AppError, resultSchema, type CommandResult } from "../shared/core.js";
import { type Envelope } from "../shared/commands.js";
import { type Query } from "../shared/snapshot.js";
import { type SkillReference } from "../shared/tools/skills.js";
import { sameCursor, type StoreCursor } from "../shared/worker-events.js";
import { createStorageModules } from "./assembly.js";
import type { CommandContext } from "./commands/context.js";
import { runCommand } from "./commands/registry.js";
import type { ConversationContextStorage } from "./chat/conversation-context.js";
import type { DeletionOperations } from "./deletions/deletion-operations.js";
import { storageDiagnostics } from "./diagnostics.js";
import type { DocumentOperations } from "./documents/document-operations.js";
import type { FileStorage } from "./documents/file-storage.js";
import type { MemoryOperations } from "./memory/memory-operations.js";
import {
  runMigrations,
  schemaMigrations,
} from "./migrations/migration-registry.js";
import { fenceRestoredState } from "./backup/restored-state.js";
import type { RunStorage } from "./runs/runs.js";
import type { SnapshotReader } from "./snapshot-reader.js";
import { CachedDatabase } from "./statement-cache.js";
import type { TemplateImporter } from "./templates/template-importer.js";
import type { TemplateOperations } from "./templates/template-operations.js";
import type { ToolOperations } from "./tools/tool-operations.js";
export type { Job } from "./job.js";
/** Single worker connection; domain operations reuse this owner’s transaction. */
export class Store {
  private readonly db: DatabaseSync;
  private readonly modules: ReturnType<typeof createStorageModules>;
  readonly views: SnapshotReader;
  readonly plugins: PluginStorage;
  readonly pluginCalls: PluginCallStorage;

  private readonly epoch = randomUUID();
  private readonly listeners = new Set<() => void>();
  private changeCounter: StatementSync | undefined;
  private dirty = false;
  private viewRevision = 0;
  private booting = true;
  readonly files: FileStorage;
  readonly runs: RunStorage;
  readonly conversationContext: ConversationContextStorage;
  readonly templateImporter: TemplateImporter;
  readonly toolOperations: ToolOperations;
  readonly documentOperations: DocumentOperations;
  readonly deletionOperations: DeletionOperations;
  readonly memoryOperations: MemoryOperations;
  readonly routineOperations: RoutineOperations;
  readonly templateOperations: TemplateOperations;
  constructor(
    private readonly path: string,
    options: { backupBeforeUpgrade?: boolean } = {},
  ) {
    this.db = new CachedDatabase(path);
    const modules = (this.modules = createStorageModules(this.db, {
      transaction: (fn) => this.transaction(fn),
      changed: () => this.changed(),
      requireBot: (id) => this.requireBot(id),
      requireConversation: (id) => this.requireConversation(id),
      fingerprint: (body) => this.fingerprint(body),
      cursor: () => this.cursor(),
      skillOwners: (id) => this.skillOwners(id),
      messageSkills: (id) => this.modules.messages.skills(id),
      createConversation: (botId, hidden) =>
        this.createConversation(botId, hidden),
      commandContext: (requestId, avatar) =>
        this.commandContext(requestId, avatar),
    }));

    this.views = modules.views;
    this.plugins = modules.plugins;
    this.pluginCalls = modules.pluginCalls;
    this.files = modules.files;
    this.runs = modules.runs;
    this.conversationContext = modules.conversationContext;
    this.templateImporter = modules.templateImporter;
    this.toolOperations = modules.toolOperations;
    this.documentOperations = modules.documentOperations;
    this.deletionOperations = modules.deletionOperations;
    this.memoryOperations = modules.memoryOperations;
    this.templateOperations = modules.templateOperations;
    this.routineOperations = modules.routineOperations;
    try {
      runMigrations(
        this.db,
        schemaMigrations(modules),
        (fn) => this.transaction(fn),
        options.backupBeforeUpgrade,
      );
      this.db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;",
      );
    } catch (error) {
      this.db.close();
      throw error;
    } finally {
      this.booting = false;
    }
  }
  private fingerprint(body: string) {
    return createHash("sha256").update(body).digest("hex");
  }
  diagnostics() {
    return storageDiagnostics(this.db);
  }
  close() {
    this.db.close();
  }
  avatarContent(access: AvatarAccess) {
    return this.modules.avatars.content(access);
  }
  skillContent(access: SkillReference) {
    if (this.modules.bots.lifecycle(access.botId) === "deleted")
      return this.modules.messages.frozenSkill(access);
    this.modules.deletions.botActive(access.botId);
    return this.modules.skills.content(access);
  }
  skillCatalog(botIds: string[]) {
    for (const id of botIds) this.requireBot(id);
    return this.modules.skills.list([...new Set(botIds)]);
  }
  private skillOwners(conversationId: string): string[] {
    const conversation = this.requireConversation(conversationId);
    return (
      this.modules.groups.read(conversationId)?.memberIds ?? [
        conversation.botId,
      ]
    );
  }
  /** 所有写入的事务入口；提交后才发布修订通知。 */
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    const before = this.totalChanges();
    try {
      const result = fn();
      this.settleRevision(before);
      this.db.exec("COMMIT");
      this.publish();
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.dirty = false;
      throw e;
    }
  }
  private totalChanges() {
    return z
      .object({ n: z.number() })
      .parse(
        (this.changeCounter ??= this.db.prepare(
          "SELECT total_changes() AS n",
        )).get(),
      ).n;
  }
  /**
   * 写了库却忘记调用 changed() 的路径同样要让界面看到变化，这里兜底补记一次。
   * 空库建表期间除外：此时还没有任何读者。
   */
  private settleRevision(before: number) {
    if (this.booting || this.dirty || this.totalChanges() === before) return;
    this.changed();
  }
  private publish() {
    if (!this.dirty) return;
    this.dirty = false;
    for (const listener of this.listeners) listener();
  }
  /** 返回值变化即代表数据变化；epoch 区分不同库，避免切换账号后 revision 回退被误判为“未变化”。 */
  cursor(): StoreCursor {
    return {
      epoch: this.epoch,
      revision:
        this.viewRevision +
        z
          .object({ revision: z.number() })
          .parse(this.db.prepare("SELECT revision FROM meta WHERE id=1").get())
          .revision,
    };
  }
  /** Invalidates device state in the view without writing an application command. */
  invalidateView() {
    this.viewRevision++;
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed() {
    this.dirty = true;
    this.db.prepare("UPDATE meta SET revision=revision+1 WHERE id=1").run();
  }
  private requireBot(id: string) {
    this.modules.deletions.botActive(id);
    this.modules.bots.require(id);
  }
  private requireConversation(id: string) {
    this.modules.deletions.conversationAvailable(id);
    return this.modules.conversations.require(id);
  }
  private createConversation(botId: string, hidden = false) {
    return this.modules.conversations.createForBot(botId, hidden);
  }
  recover() {
    this.transaction(() => {
      this.modules.pluginCalls.recover();
      this.modules.messages.recover();
      this.runs.recover();
      this.modules.groups.recover();
      this.modules.memoryJobs.recover();
      this.modules.deletions.recover();
      this.modules.toolCalls.recover();
      this.modules.documents.recover();
      this.changed();
    });
  }
  private commandContext(
    requestId?: string,
    validatedAvatar?: ValidatedAvatar,
  ): CommandContext {
    return {
      bots: this.modules.bots,
      conversations: this.modules.conversations,
      messages: this.modules.messages,
      dataPath: this.path,
      requestId,
      validatedAvatar,
      groups: this.modules.groups,
      routines: this.modules.routines,
      templates: this.modules.templates,
      plugins: this.plugins,
      templateTools: this.modules.templateTools,
      avatars: this.modules.avatars,
      skills: this.modules.skills,
      memory: this.modules.memory,
      memoryJobs: this.modules.memoryJobs,
      sharedMemory: this.modules.sharedMemory,
      toolCalls: this.modules.toolCalls,
      questions: this.modules.questions,
      deletions: this.modules.deletions,
      sidebar: this.modules.sidebar,
      requireBot: (id) => this.requireBot(id),
      requireConversation: (id) => this.requireConversation(id),
      createConversation: (botId, hidden) =>
        this.createConversation(botId, hidden),
      skillOwners: (conversationId) => this.skillOwners(conversationId),
      enqueueRoutine: (botId, text) =>
        this.routineOperations.enqueue(botId, text),
      quote: (conversationId, messageId) =>
        this.runs.quote(conversationId, messageId),
      getRun: (id) => this.runs.getRun(id),
      changed: () => this.changed(),
      canonicalPath: (path) => this.files.canonicalPath(path),
    };
  }
  execute(
    envelope: Envelope,
    validatedAvatar?: ValidatedAvatar,
  ): CommandResult {
    return this.transaction(() => {
      if (envelope.expectedEpoch && envelope.expectedEpoch !== this.epoch)
        throw new AppError(
          "unauthorized",
          "账户数据已切换，请重新选择授权目录。",
        );
      const body = this.fingerprint(JSON.stringify(envelope.command));
      const old = this.db
        .prepare("SELECT body,result FROM commands WHERE id=?")
        .get(envelope.id);
      if (old) {
        const record = z
          .object({ body: z.string(), result: z.string() })
          .parse(old);
        if (record.body !== body)
          throw new AppError("conflict", "相同命令编号不能用于不同操作。");
        const result = resultSchema.parse(JSON.parse(record.result));
        // Legacy bot creation also created its only conversation, now migrated with the same ID.
        if (
          envelope.command.type === "bot.create" &&
          result.id &&
          !result.conversationId
        )
          return { ...result, conversationId: result.id };
        return result;
      }
      const command = envelope.command;
      this.modules.deletions.guard(command);
      const result = runCommand(
        command,
        this.commandContext(envelope.id, validatedAvatar),
      );
      this.db
        .prepare("INSERT INTO commands VALUES(?,?,?)")
        .run(envelope.id, body, JSON.stringify(result));
      this.changed();
      return result;
    });
  }
  /** 游标一致时跳过会话与消息查询。 */
  snapshotSince(query: Query) {
    const cursor = this.cursor();
    if (query.since && sameCursor(query.since, cursor)) return undefined;
    return this.views.snapshot(query);
  }
  /** Only the restore coordinator calls this on a migrated, isolated staged copy. */
  prepareRestoredSnapshot() {
    this.transaction(() => {
      fenceRestoredState(this.db);
      this.changed();
    });
  }
}
