import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { defaultAvatar } from "../../shared/avatar.js";
import { AppError } from "../../shared/core.js";
import { type Command } from "../../shared/commands.js";
import {
  deletionPlanSchema,
  deletionSchema,
  type DeletionCommand,
  type DeletionPlan,
} from "../../shared/deletions.js";
import { purgeConversation } from "../chat/conversation-purge.js";

/** All writes belong to Store's synchronous transaction. Files and provider calls occur elsewhere. */
export class DeletionStorage {
  constructor(private readonly db: DatabaseSync) {}
  migrate() {
    this.db.exec(`
      ALTER TABLE bots ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','deleting','deleted'));
      CREATE TABLE deletions(id TEXT PRIMARY KEY,kind TEXT NOT NULL,targetId TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,error TEXT,createdAt INTEGER NOT NULL,planJson TEXT,attempt INTEGER NOT NULL DEFAULT 0,UNIQUE(kind,targetId));
      CREATE TABLE deletion_conversations(deletionId TEXT NOT NULL REFERENCES deletions(id),conversationId TEXT PRIMARY KEY REFERENCES conversations(id),removeContent INTEGER NOT NULL);
      CREATE TABLE thread_owners(threadId TEXT PRIMARY KEY,botId TEXT NOT NULL REFERENCES bots(id),conversationId TEXT NOT NULL REFERENCES conversations(id));
      CREATE TABLE deleted_client_keys(key TEXT PRIMARY KEY);
      INSERT INTO thread_owners SELECT threadId,botId,id FROM conversations WHERE threadId IS NOT NULL;
      INSERT INTO thread_owners SELECT threadId,botId,conversationId FROM group_members WHERE threadId IS NOT NULL;
    `);
  }
  botActive(botId: string) {
    if (
      this.db.prepare("SELECT lifecycle FROM bots WHERE id=?").get(botId)
        ?.lifecycle !== "active"
    )
      throw new AppError("not_found", "Bot 已删除或正在清理，不能开始新操作。");
  }
  conversationAvailable(id: string) {
    if (
      this.db
        .prepare("SELECT 1 FROM deletion_conversations WHERE conversationId=?")
        .get(id)
    )
      throw new AppError(
        "conflict",
        "此会话关联的删除正在处理，请等待清理完成。",
      );
  }
  guard(command: Command) {
    if (
      command.type === "entity.delete" ||
      command.type === "deletion.retry" ||
      command.type === "run.cancel"
    )
      return;
    if ("botId" in command) this.botActive(command.botId);
    if ("scope" in command && "botId" in command.scope) {
      this.botActive(command.scope.botId);
      if (command.scope.conversationId)
        this.conversationAvailable(command.scope.conversationId);
    }
    if ("conversationId" in command && command.conversationId)
      this.conversationAvailable(command.conversationId);
    if ("memberIds" in command)
      for (const id of command.memberIds) this.botActive(id);
    if (command.type === "reaction.set") {
      const row = this.db
        .prepare("SELECT conversationId FROM messages WHERE id=?")
        .get(command.messageId);
      if (row) this.conversationAvailable(z.string().parse(row.conversationId));
    }
    if (command.type === "tool.decide") {
      const row = this.db
        .prepare("SELECT botId,conversationId FROM computer_calls WHERE id=?")
        .get(command.id);
      if (row) {
        this.botActive(z.string().parse(row.botId));
        this.conversationAvailable(z.string().parse(row.conversationId));
      }
    }
  }
  begin(command: Extract<DeletionCommand, { type: "entity.delete" }>) {
    const previous = this.db
      .prepare("SELECT id FROM deletions WHERE kind=? AND targetId=?")
      .get(command.kind, command.targetId);
    if (previous) return { id: z.string().parse(previous.id) };
    if (
      Number(
        this.db
          .prepare("SELECT count(*) n FROM deletions WHERE status<>'completed'")
          .get()?.n,
      ) >= 16
    )
      throw new AppError(
        "capacity",
        "待清理项目已达十六项，请先处理已有失败或排队记录。",
      );
    const target =
      command.kind === "bot"
        ? this.db
            .prepare("SELECT name FROM bots WHERE id=? AND lifecycle='active'")
            .get(command.targetId)
        : this.db
            .prepare("SELECT name FROM groups WHERE conversationId=?")
            .get(command.targetId);
    if (!target) throw new AppError("not_found", "删除目标已不存在。");
    if (target.name !== command.expectedName)
      throw new AppError("conflict", "目标名称已改变，请重新确认删除范围。");
    const affected =
      command.kind === "group"
        ? [{ id: command.targetId, removeContent: 1 }]
        : this.db
            .prepare(
              `SELECT c.id,CASE WHEN g.conversationId IS NULL THEN 1 ELSE 0 END removeContent
          FROM conversations c LEFT JOIN groups g ON g.conversationId=c.id WHERE
          (c.botId=? AND g.conversationId IS NULL) OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversationId=c.id AND m.botId=?)`,
            )
            .all(command.targetId, command.targetId)
            .map((row) =>
              z
                .object({ id: z.string(), removeContent: z.number() })
                .parse(row),
            );
    for (const conversation of affected)
      this.conversationAvailable(conversation.id);
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO deletions(id,kind,targetId,name,status,error,createdAt,planJson) VALUES(?,?,?,?,'queued',NULL,?,NULL)",
      )
      .run(
        id,
        command.kind,
        command.targetId,
        command.expectedName,
        Date.now(),
      );
    for (const conversation of affected)
      this.db
        .prepare("INSERT INTO deletion_conversations VALUES(?,?,?)")
        .run(id, conversation.id, conversation.removeContent);
    if (command.kind === "bot")
      this.db
        .prepare("UPDATE bots SET lifecycle='deleting' WHERE id=?")
        .run(command.targetId);
    // Revocation is committed before any asynchronous cleanup is scheduled.
    this.db
      .prepare(
        `UPDATE runs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,error='关联对象正在删除。'
      WHERE conversationId IN(SELECT conversationId FROM deletion_conversations WHERE deletionId=?) AND status IN('queued','running')`,
      )
      .run(id);
    this.db
      .prepare(
        `UPDATE group_turns SET status='cancelled',error='关联对象正在删除。' WHERE status='queued' AND runId IN
      (SELECT id FROM runs WHERE conversationId IN(SELECT conversationId FROM deletion_conversations WHERE deletionId=?))`,
      )
      .run(id);
    this.db
      .prepare(
        `UPDATE questions SET status='cancelled' WHERE status='pending' AND conversationId IN(SELECT conversationId FROM deletion_conversations WHERE deletionId=?)`,
      )
      .run(id);
    this.db
      .prepare(
        `UPDATE computer_calls SET status=CASE WHEN status IN('running','cancelling') THEN 'cancelling' ELSE 'cancelled' END,detail='关联对象正在删除。'
      WHERE status IN('pending','approved','running','cancelling') AND conversationId IN(SELECT conversationId FROM deletion_conversations WHERE deletionId=?)`,
      )
      .run(id);
    const scopes = command.kind === "bot" ? "botId=?" : "conversationId=?";
    this.db
      .prepare(
        `UPDATE memory_scopes SET automatic=0,revision=revision+1 WHERE ${scopes}`,
      )
      .run(command.targetId);
    this.db
      .prepare(
        `UPDATE memory_jobs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,error='关联对象正在删除。'
      WHERE status IN('queued','proposing','verifying') AND (botId,scopeId) IN(SELECT botId,scopeId FROM memory_scopes WHERE ${scopes})`,
      )
      .run(command.targetId);
    return { id };
  }
  list() {
    return this.db
      .prepare(
        "SELECT * FROM deletions WHERE status<>'completed' ORDER BY createdAt,rowid",
      )
      .all()
      .map((row) => deletionSchema.parse(row));
  }
  clientKeys() {
    return this.db
      .prepare("SELECT key FROM deleted_client_keys ORDER BY key")
      .all()
      .map((row) => z.string().parse(row.key));
  }
  next() {
    const row = this.db
      .prepare(
        "SELECT * FROM deletions WHERE status='queued' ORDER BY createdAt,rowid LIMIT 1",
      )
      .get();
    return row ? deletionSchema.parse(row) : null;
  }
  get(id: string) {
    const row = this.db.prepare("SELECT * FROM deletions WHERE id=?").get(id);
    if (!row) throw new AppError("not_found", "删除记录不存在。");
    return deletionSchema.parse(row);
  }
  start(id: string) {
    this.db
      .prepare(
        "UPDATE deletions SET status='cleaning',error=NULL WHERE id=? AND status='queued'",
      )
      .run(id);
  }
  retry(id: string) {
    if (this.get(id).status !== "failed")
      throw new AppError("conflict", "只有失败的清理可以重试。");
    this.db
      .prepare(
        "UPDATE deletions SET status='queued',error=NULL,attempt=attempt+1 WHERE id=?",
      )
      .run(id);
  }
  fail(id: string, detail: string, paused = false) {
    this.db
      .prepare(
        "UPDATE deletions SET status=?,error=? WHERE id=? AND status='cleaning'",
      )
      .run(paused ? "queued" : "failed", detail.slice(0, 1000), id);
  }
  recover() {
    this.db
      .prepare(
        "UPDATE deletions SET status='queued',error='上次清理中断，将先核实资源再继续。' WHERE status='cleaning'",
      )
      .run();
  }
  runIds(id: string) {
    return this.db
      .prepare(
        "SELECT id FROM runs WHERE conversationId IN(SELECT conversationId FROM deletion_conversations WHERE deletionId=?) AND status IN('running','cancelling')",
      )
      .all(id)
      .map((row) => z.string().parse(row.id));
  }
  rememberThread(botId: string, conversationId: string, threadId: string) {
    const previous = this.db
      .prepare(
        "SELECT botId,conversationId FROM thread_owners WHERE threadId=?",
      )
      .get(threadId);
    if (
      previous &&
      (previous.botId !== botId || previous.conversationId !== conversationId)
    )
      throw new AppError("unauthorized", "模型会话已属于另一个运行范围。");
    this.db
      .prepare("INSERT OR IGNORE INTO thread_owners VALUES(?,?,?)")
      .run(threadId, botId, conversationId);
  }
  plan(id: string): DeletionPlan {
    const saved = this.db
      .prepare("SELECT planJson FROM deletions WHERE id=?")
      .get(id)?.planJson;
    if (saved)
      return deletionPlanSchema.parse(JSON.parse(z.string().parse(saved)));
    if (this.runIds(id).length)
      throw new AppError("conflict", "运行仍在停止，尚不能清理。");
    const job = this.get(id);
    const conversations = this.db
      .prepare(
        "SELECT conversationId FROM deletion_conversations WHERE deletionId=? AND removeContent=1",
      )
      .all(id)
      .map((row) => z.string().parse(row.conversationId));
    const plan: DeletionPlan = {
      conversations,
      threads: [],
      caches: [],
      botId: job.kind === "bot" ? job.targetId : null,
    };
    if (job.kind === "bot") {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM thread_owners WHERE botId=? UNION SELECT 1 FROM runs WHERE botId=? LIMIT 1",
          )
          .get(job.targetId, job.targetId)
      )
        plan.threads.push({
          botId: job.targetId,
          ids: this.db
            .prepare("SELECT threadId FROM thread_owners WHERE botId=?")
            .all(job.targetId)
            .map((row) => z.string().parse(row.threadId)),
          all: true,
        });
    } else {
      const threads = this.db
        .prepare(
          "SELECT botId,threadId FROM thread_owners WHERE conversationId=?",
        )
        .all(job.targetId);
      for (const row of threads) {
        const thread = z
          .object({ botId: z.uuid(), threadId: z.string() })
          .parse(row);
        let item = plan.threads.find((item) => item.botId === thread.botId);
        if (!item) {
          item = { botId: thread.botId, ids: [], all: false };
          plan.threads.push(item);
        }
        item.ids.push(thread.threadId);
      }
    }
    for (const conversationId of conversations) {
      const members = this.db
        .prepare("SELECT botId FROM group_members WHERE conversationId=?")
        .all(conversationId)
        .map((row) => z.string().parse(row.botId));
      if (!members.length)
        members.push(
          z
            .string()
            .parse(
              this.db
                .prepare("SELECT botId FROM conversations WHERE id=?")
                .get(conversationId)?.botId,
            ),
        );
      const attachments = this.db
        .prepare("SELECT id,mime FROM attachments WHERE conversationId=?")
        .all(conversationId);
      for (const attachment of attachments) {
        const extension =
          attachment.mime === "image/png"
            ? "png"
            : attachment.mime === "image/jpeg"
              ? "jpg"
              : attachment.mime === "image/webp"
                ? "webp"
                : "txt";
        for (const botId of members)
          plan.caches.push({
            botId,
            fileName: `${z.string().parse(attachment.id)}.${extension}`,
          });
      }
    }
    const checked = deletionPlanSchema.parse(plan),
      json = JSON.stringify(checked);
    if (Buffer.byteLength(json) > 8 * 1024 * 1024)
      throw new AppError(
        "capacity",
        "清理清单超过 8 MiB，请保留数据并检查，未截断清单。",
      );
    this.db.prepare("UPDATE deletions SET planJson=? WHERE id=?").run(json, id);
    return checked;
  }
  complete(id: string) {
    const job = this.get(id),
      plan = this.plan(id);
    if (job.status !== "cleaning" || this.runIds(id).length)
      throw new AppError("conflict", "清理尚未确认停止。");
    for (const conversationId of plan.conversations)
      purgeConversation(this.db, conversationId);
    if (plan.botId) {
      const botId = plan.botId;
      this.db
        .prepare("INSERT OR IGNORE INTO deleted_client_keys VALUES(?)")
        .run(`bot-copy:${botId}`);
      this.db
        .prepare("INSERT OR IGNORE INTO deleted_client_keys VALUES(?)")
        .run(`routine-editor:${botId}`);
      this.db
        .prepare("INSERT OR IGNORE INTO deleted_client_keys VALUES(?)")
        .run(`skill-editor:${botId}`);
      this.db
        .prepare("INSERT OR IGNORE INTO deleted_client_keys VALUES(?)")
        .run(`computer-command:${botId}`);
      this.db
        .prepare("INSERT OR IGNORE INTO deleted_client_keys VALUES(?)")
        .run(`memory-editor:${botId}:bot`);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO deleted_client_keys SELECT 'memory-editor:'||botId||':'||scopeId FROM memory_scopes WHERE botId=? AND conversationId IS NOT NULL",
        )
        .run(botId);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO deleted_client_keys SELECT 'memory-editor:'||botId||':'||conversationId FROM group_members WHERE botId=?",
        )
        .run(botId);
      this.db.prepare("DELETE FROM plugins WHERE botId=?").run(botId);
      this.db.prepare("DELETE FROM routines WHERE botId=?").run(botId);
      this.db.prepare("DELETE FROM memory_jobs WHERE botId=?").run(botId);
      this.db.prepare("DELETE FROM memories WHERE botId=?").run(botId);
      this.db.prepare("DELETE FROM memory_scopes WHERE botId=?").run(botId);
      this.db.prepare("DELETE FROM group_context WHERE botId=?").run(botId);
      this.db
        .prepare(
          "UPDATE group_members SET active=0,threadId=NULL,contextSequence=0 WHERE botId=?",
        )
        .run(botId);
      this.db
        .prepare(
          "UPDATE groups SET revision=revision+1,draftRecipientJson='[]',hostBotId=CASE WHEN hostBotId=? THEN NULL ELSE hostBotId END WHERE conversationId IN(SELECT conversationId FROM group_members WHERE botId=?)",
        )
        .run(botId, botId);
      for (const row of this.db
        .prepare(
          "SELECT id,draftSkillsJson FROM conversations WHERE draftSkillsJson<>'[]'",
        )
        .all()) {
        const refs = z
          .array(z.object({ botId: z.string() }).passthrough())
          .parse(JSON.parse(z.string().parse(row.draftSkillsJson)));
        this.db
          .prepare("UPDATE conversations SET draftSkillsJson=? WHERE id=?")
          .run(
            JSON.stringify(refs.filter((ref) => ref.botId !== botId)),
            z.string().parse(row.id),
          );
      }
      this.db.prepare("DELETE FROM thread_owners WHERE botId=?").run(botId);
      this.db.prepare("DELETE FROM taught_skills WHERE botId=?").run(botId);
      this.db
        .prepare(
          "DELETE FROM skill_versions WHERE id IN(SELECT id FROM skills WHERE botId=?)",
        )
        .run(botId);
      this.db.prepare("DELETE FROM skills WHERE botId=?").run(botId);
      this.db
        .prepare("DELETE FROM computer_maintenance WHERE botId=?")
        .run(botId);
      this.db.prepare("DELETE FROM bot_avatar_images WHERE botId=?").run(botId);
      this.db.prepare("DELETE FROM computers WHERE botId=?").run(botId);
      this.db
        .prepare(
          "UPDATE bots SET lifecycle='deleted',name='已删除的 Bot',description='',tags='',language='auto',avatarJson=? WHERE id=?",
        )
        .run(JSON.stringify(defaultAvatar), botId);
    }
    this.db
      .prepare("DELETE FROM deletion_conversations WHERE deletionId=?")
      .run(id);
    this.db
      .prepare(
        "UPDATE deletions SET status='completed',error=NULL,name='',planJson=NULL WHERE id=?",
      )
      .run(id);
  }
}
