import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  memoryProposalSchema,
  type MemoryJobStatus,
  type MemoryProposal,
  type MemoryScope,
  type MemoryWork,
  type memoryJobActionSchema,
} from "../../shared/memory.js";
import type { MemoryStorage } from "./memory.js";
const scopeId = (scope: MemoryScope) => scope.conversationId ?? scope.botId;
const key = (text: string) => text.normalize("NFKC").trim().toLocaleLowerCase();
const pending = "('queued','proposing','verifying','cancelling')";
/** Queue ownership and verified proposals; writes reuse the owner's transaction. */
export class MemoryJobStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly entries: Pick<
      MemoryStorage,
      "ensure" | "validate" | "view" | "checkCapacity" | "bump"
    >,
  ) {}
  action(command: z.infer<typeof memoryJobActionSchema>) {
    const { scope } = command;
    this.entries.ensure(scope);
    const row = this.db
      .prepare(
        "SELECT j.*,m.sequence FROM memory_jobs j JOIN messages m ON m.id=j.sourceMessageId WHERE j.id=? AND j.botId=? AND j.scopeId=?",
      )
      .get(command.id, scope.botId, scopeId(scope));
    if (!row) throw new AppError("not_found", "提炼任务不存在。");
    if (command.action === "cancel") {
      this.db
        .prepare(
          `UPDATE memory_jobs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,error='用户已请求取消提炼。' WHERE id=? AND status IN ${pending}`,
        )
        .run(command.id);
      return;
    }
    const state = this.db
      .prepare(
        "SELECT automatic,afterSequence FROM memory_scopes WHERE botId=? AND scopeId=?",
      )
      .get(scope.botId, scopeId(scope));
    if (
      state?.automatic !== 1 ||
      z.number().parse(row.sequence) <= z.number().parse(state.afterSequence)
    )
      throw new AppError(
        "conflict",
        "该证据已被遗忘或设置变更作废，不能重试。",
      );
    if (
      !["failed", "conflict", "cancelled"].includes(
        z.string().parse(row.status),
      )
    )
      throw new AppError("conflict", "该任务不能重复入队。");
    this.checkQueue();
    this.db
      .prepare("UPDATE memory_jobs SET status='queued',error=NULL WHERE id=?")
      .run(command.id);
  }
  enqueueRun(runId: string) {
    const message = this.db
      .prepare(
        "SELECT m.id,m.botId,m.conversationId,m.sequence,m.text FROM messages m WHERE m.runId=? AND m.role='user'",
      )
      .get(runId);
    if (!message || !z.string().parse(message.text).trim()) return;
    const conId = z.string().parse(message.conversationId);
    const group = this.db
      .prepare("SELECT 1 FROM groups WHERE conversationId=?")
      .get(conId);
    const owners = group
      ? this.db
          .prepare(
            "SELECT DISTINCT botId FROM group_turns WHERE runId=? AND status IN ('completed','skipped')",
          )
          .all(runId)
          .map((r) => z.string().parse(r.botId))
      : [z.string().parse(message.botId)];
    for (const botId of owners) {
      const scope: MemoryScope = {
        botId,
        conversationId: group ? conId : null,
      };
      const state = this.db
        .prepare(
          "SELECT automatic,afterSequence FROM memory_scopes WHERE botId=? AND scopeId=?",
        )
        .get(botId, scopeId(scope));
      if (
        state?.automatic !== 1 ||
        z.number().parse(message.sequence) <=
          z.number().parse(state.afterSequence)
      )
        continue;
      const full = this.pendingCount() >= 100;
      this.db
        .prepare(
          "INSERT OR IGNORE INTO memory_jobs(id,botId,scopeId,sourceMessageId,status,error,createdAt) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          botId,
          scopeId(scope),
          z.string().parse(message.id),
          full ? "failed" : "queued",
          full ? "提炼队列已满，请稍后明确重试。" : null,
          Date.now(),
        );
    }
    this.prune();
  }
  private pendingCount() {
    return z
      .number()
      .parse(
        this.db
          .prepare(
            `SELECT count(*) n FROM memory_jobs WHERE status IN ${pending}`,
          )
          .get()?.n,
      );
  }
  private checkQueue() {
    if (this.pendingCount() >= 100)
      throw new AppError("capacity", "提炼队列已满，请稍后重试。");
  }
  claim(): MemoryWork | null {
    this.db.exec(
      `UPDATE memory_jobs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,error='Bot 已退出该群聊，停止提炼。' WHERE status IN ${pending} AND EXISTS(SELECT 1 FROM memory_scopes s WHERE s.botId=memory_jobs.botId AND s.scopeId=memory_jobs.scopeId AND s.conversationId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM group_members g WHERE g.conversationId=s.conversationId AND g.botId=s.botId AND g.active=1))`,
    );
    const row = this.db
      .prepare(
        "SELECT j.id,j.botId,j.sourceMessageId,s.conversationId,s.revision,m.text FROM memory_jobs j JOIN memory_scopes s ON s.botId=j.botId AND s.scopeId=j.scopeId JOIN messages m ON m.id=j.sourceMessageId WHERE j.status='queued' AND s.automatic=1 AND m.sequence>s.afterSequence ORDER BY j.createdAt,j.rowid LIMIT 1",
      )
      .get();
    if (!row) return null;
    const parsed = z
      .object({
        id: z.uuid(),
        botId: z.uuid(),
        sourceMessageId: z.uuid(),
        conversationId: z.uuid().nullable(),
        revision: z.number(),
        text: z.string().max(32000),
      })
      .parse(row);
    const scope: MemoryScope = {
      botId: parsed.botId,
      conversationId: parsed.conversationId,
    };
    this.entries.validate(scope);
    this.db
      .prepare(
        "UPDATE memory_jobs SET status='proposing',revision=? WHERE id=? AND status='queued'",
      )
      .run(parsed.revision, parsed.id);
    return {
      ...parsed,
      scope,
      entries: this.entries.view(scope).entries,
      forgottenTopics: this.db
        .prepare(
          "SELECT topic FROM memories WHERE botId=? AND scopeId=? AND deleted=1",
        )
        .all(scope.botId, scopeId(scope))
        .map((r) => z.string().parse(r.topic)),
    };
  }
  active(work: MemoryWork) {
    const row = this.db
      .prepare("SELECT status,revision FROM memory_jobs WHERE id=?")
      .get(work.id);
    return (
      !!row &&
      ["proposing", "verifying"].includes(z.string().parse(row.status)) &&
      row.revision === work.revision &&
      (!work.scope.conversationId ||
        !!this.db
          .prepare(
            "SELECT 1 FROM group_members WHERE conversationId=? AND botId=? AND active=1",
          )
          .get(work.scope.conversationId, work.scope.botId))
    );
  }
  verifying(work: MemoryWork) {
    if (!this.active(work))
      throw new AppError("conflict", "提炼已取消或状态过期。");
    this.db
      .prepare("UPDATE memory_jobs SET status='verifying' WHERE id=?")
      .run(work.id);
  }
  apply(work: MemoryWork, raw: MemoryProposal) {
    if (!this.active(work)) return;
    this.entries.validate(work.scope);
    const state = this.db
      .prepare("SELECT revision FROM memory_scopes WHERE botId=? AND scopeId=?")
      .get(work.scope.botId, scopeId(work.scope));
    if (state?.revision !== work.revision)
      throw new AppError("conflict", "提炼期间记忆已修改，候选未覆盖新内容。");
    const { changes, conflicts } = memoryProposalSchema.parse(raw),
      topics = new Set<string>(),
      ids = new Set<string>();
    if (conflicts.length)
      throw new AppError(
        "conflict",
        "候选与手动记忆冲突：" + conflicts.join("；"),
      );
    for (const change of changes) {
      const topicKey = key(change.topic);
      if (
        !work.text.includes(change.quote) ||
        topics.has(topicKey) ||
        (change.id !== null && ids.has(change.id))
      )
        throw new AppError("invalid_input", "候选引文无效或主题重复，未保存。");
      topics.add(topicKey);
      if (change.id) ids.add(change.id);
      const existing = this.db
        .prepare(
          "SELECT * FROM memories WHERE botId=? AND scopeId=? AND topicKey=?",
        )
        .get(work.scope.botId, scopeId(work.scope), topicKey);
      if (change.id === null) {
        if (existing)
          throw new AppError(
            "conflict",
            "候选主题已存在或已被忘记，未自动恢复。",
          );
        if (change.revision !== 0)
          throw new AppError("invalid_input", "新候选修订无效。");
        this.entries.checkCapacity(work.scope);
      } else if (
        !existing ||
        existing.id !== change.id ||
        existing.deleted !== 0 ||
        existing.revision !== change.revision ||
        existing.origin !== "automatic"
      )
        throw new AppError(
          "conflict",
          "候选与已有或手动记忆冲突，请手动核实。",
        );
      this.db
        .prepare(
          `INSERT INTO memories(id,botId,scopeId,topic,topicKey,content,revision,origin,sourceMessageId,sourceQuote,updatedAt) VALUES(?,?,?,?,?,?,?,'automatic',?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,revision=excluded.revision,sourceMessageId=excluded.sourceMessageId,sourceQuote=excluded.sourceQuote,updatedAt=excluded.updatedAt`,
        )
        .run(
          change.id ?? randomUUID(),
          work.scope.botId,
          scopeId(work.scope),
          change.topic,
          topicKey,
          change.content,
          change.revision + 1,
          work.sourceMessageId,
          change.quote,
          Date.now(),
        );
    }
    if (changes.length) this.entries.bump(work.scope);
    this.end(work, "completed", null);
  }
  end(work: MemoryWork, status: MemoryJobStatus, error: string | null) {
    const row = this.db
      .prepare("SELECT status,revision FROM memory_jobs WHERE id=?")
      .get(work.id);
    if (
      row?.revision === work.revision &&
      ["proposing", "verifying", "cancelling"].includes(
        z.string().parse(row.status),
      )
    )
      this.db
        .prepare("UPDATE memory_jobs SET status=?,error=? WHERE id=?")
        .run(status, error, work.id);
    this.prune();
  }
  recover() {
    this.db
      .prepare(
        "UPDATE memory_jobs SET status='failed',error='后台在提炼期间关闭，未提交候选；可以明确重试。' WHERE status IN ('proposing','verifying','cancelling')",
      )
      .run();
  }
  private prune() {
    this.db.exec(
      "DELETE FROM memory_jobs WHERE id IN (SELECT id FROM memory_jobs WHERE status IN ('completed','cancelled','failed','conflict') ORDER BY createdAt DESC,rowid DESC LIMIT -1 OFFSET 1000)",
    );
  }
}
