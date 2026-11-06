import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../shared/core.js";
import {
  routineSchema,
  routineEventSchema,
  type Routine,
  type RoutineQuery,
} from "../shared/routines.js";
import { RoutineToolCallStorage } from "./tool-calls.js";

/** Routine persistence shares the Store connection and caller-owned transaction. */
export class RoutineRepository {
  readonly calls: RoutineToolCallStorage;
  constructor(private readonly db: DatabaseSync) {
    this.calls = new RoutineToolCallStorage(db);
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE routines(id TEXT PRIMARY KEY,botId TEXT NOT NULL REFERENCES bots(id),name TEXT NOT NULL,prompt TEXT NOT NULL,scheduleJson TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('active','paused','deleted')),revision INTEGER NOT NULL,nextAt INTEGER,createdAt INTEGER NOT NULL,keyHash TEXT,error TEXT);
      CREATE INDEX routine_due ON routines(nextAt) WHERE state='active';
      CREATE INDEX routine_bot ON routines(botId,createdAt);
      CREATE TABLE routine_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,routineId TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,source TEXT NOT NULL,triggerKey TEXT NOT NULL,payloadHash TEXT NOT NULL,createdAt INTEGER NOT NULL,scheduledAt INTEGER,coveredUntil INTEGER,definitionRevision INTEGER NOT NULL,name TEXT NOT NULL,prompt TEXT NOT NULL,runId TEXT REFERENCES runs(id) ON DELETE CASCADE,conversationId TEXT REFERENCES conversations(id) ON DELETE CASCADE,error TEXT,UNIQUE(routineId,triggerKey));
      CREATE INDEX routine_event_history ON routine_events(routineId,sequence);
      CREATE INDEX routine_event_run ON routine_events(runId);
      CREATE TABLE routine_tool_calls(runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,callId TEXT NOT NULL,fingerprint TEXT NOT NULL,resultJson TEXT NOT NULL,messageId TEXT REFERENCES messages(id) ON DELETE CASCADE,receiptJson TEXT,PRIMARY KEY(runId,callId));
    `);
  }
  activeBot(botId: string) {
    if (
      this.db.prepare("SELECT lifecycle FROM bots WHERE id=?").get(botId)
        ?.lifecycle !== "active"
    )
      throw new AppError("not_found", "Bot 已删除或正在清理。");
  }
  private parse(row: Record<string, unknown>): Routine {
    return routineSchema.parse({
      ...row,
      schedule: JSON.parse(z.string().parse(row.scheduleJson)),
      hasKey: row.keyHash !== null,
    });
  }
  get(id: string): Routine {
    const row = this.db.prepare("SELECT * FROM routines WHERE id=?").get(id);
    if (!row) throw new AppError("not_found", "例行任务已不存在。");
    return this.parse(row);
  }
  view(query: RoutineQuery) {
    this.activeBot(query.botId);
    if (query.routineId && this.get(query.routineId).botId !== query.botId)
      throw new AppError("unauthorized", "任务不属于当前 Bot。");
    const rows = query.routineId
      ? this.db
          .prepare(
            `${this.eventSelect} WHERE e.routineId=? AND e.sequence<? ORDER BY e.sequence DESC LIMIT 51`,
          )
          .all(query.routineId, query.before ?? Number.MAX_SAFE_INTEGER)
      : [];
    return {
      routines: this.db
        .prepare(
          "SELECT * FROM routines WHERE botId=? ORDER BY createdAt DESC,id",
        )
        .all(query.botId)
        .map((row) => this.parse(row)),
      events: rows.slice(0, 50).map((row) => routineEventSchema.parse(row)),
      hasOlder: rows.length > 50,
    };
  }
  private readonly eventSelect = `SELECT e.*,r.conversationId AS conversationId,COALESCE(r.status,'skipped') AS status,COALESCE(r.error,e.error) AS error FROM routine_events e LEFT JOIN runs r ON r.id=e.runId`;
  event(id: string, routineId: string) {
    const row = this.db
      .prepare(`${this.eventSelect} WHERE e.id=? AND e.routineId=?`)
      .get(id, routineId);
    if (!row) throw new AppError("not_found", "触发记录不存在。");
    return routineEventSchema.parse(row);
  }
  isRun(runId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM routine_events WHERE runId=? LIMIT 1")
      .get(runId);
  }
  scheduledOneTimeRuns(runId: string) {
    return this.db
      .prepare(
        `SELECT r.id,e.source FROM routine_events e JOIN routines r ON r.id=e.routineId
         WHERE e.runId=? AND e.source='schedule' AND json_extract(r.scheduleJson,'$.kind')='at'`,
      )
      .all(runId);
  }
  retire(id: string) {
    this.db
      .prepare(
        "UPDATE routines SET state='deleted',nextAt=NULL,error=NULL,revision=revision+1 WHERE id=? AND state='active'",
      )
      .run(id);
  }
  completionError(id: string, error: string) {
    this.db
      .prepare(
        "UPDATE routines SET error=?,revision=revision+1 WHERE id=? AND state='active'",
      )
      .run(error, id);
  }
  find(id: string) {
    const row = this.db.prepare("SELECT * FROM routines WHERE id=?").get(id);
    return row ? { routine: this.parse(row), keyHash: row.keyHash } : undefined;
  }
  count(botId: string) {
    return z
      .object({ total: z.number(), own: z.number() })
      .parse(
        this.db
          .prepare(
            "SELECT count(*) total,COALESCE(sum(botId=?),0) own FROM routines WHERE state<>'deleted'",
          )
          .get(botId),
      );
  }
  create(routine: Routine, now: number) {
    this.db
      .prepare("INSERT INTO routines VALUES(?,?,?,?,?,?,1,?,?,NULL,NULL)")
      .run(
        routine.id,
        routine.botId,
        routine.name,
        routine.prompt,
        JSON.stringify(routine.schedule),
        routine.state,
        routine.nextAt,
        now,
      );
  }
  update(routine: Routine) {
    const schedule = JSON.stringify(routine.schedule);
    this.db
      .prepare(
        "UPDATE routines SET name=?,prompt=?,scheduleJson=?,state=?,nextAt=?,keyHash=CASE WHEN scheduleJson=? THEN keyHash ELSE NULL END,error=NULL,revision=revision+1 WHERE id=?",
      )
      .run(
        routine.name,
        routine.prompt,
        schedule,
        routine.state,
        routine.nextAt,
        schedule,
        routine.id,
      );
  }
  key(id: string, hash: string | null) {
    this.db
      .prepare("UPDATE routines SET keyHash=?,revision=revision+1 WHERE id=?")
      .run(hash, id);
  }
  setState(id: string, state: Routine["state"], nextAt: number | null) {
    this.db
      .prepare(
        "UPDATE routines SET state=?,nextAt=?,error=NULL,revision=revision+1,keyHash=CASE WHEN ?='deleted' THEN NULL ELSE keyHash END WHERE id=?",
      )
      .run(state, nextAt, state, id);
    if (state === "deleted")
      this.db
        .prepare(
          "UPDATE runs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END WHERE id IN(SELECT runId FROM routine_events WHERE routineId=?) AND status IN('queued','running')",
        )
        .run(id);
  }
  context(botId: string) {
    return this.db
      .prepare(
        "SELECT * FROM routines WHERE botId=? AND state<>'deleted' ORDER BY createdAt,id LIMIT 16",
      )
      .all(botId)
      .map((row) => this.parse(row));
  }
  notificationRun(runId: string, botId: string) {
    return this.db
      .prepare("SELECT status FROM runs WHERE id=? AND botId=?")
      .get(runId, botId);
  }
  notification(itemId: string) {
    return this.db
      .prepare("SELECT id,conversationId FROM messages WHERE itemId=? LIMIT 1")
      .get(itemId);
  }
  notificationCount(runId: string) {
    return z
      .object({ n: z.number() })
      .parse(
        this.db
          .prepare("SELECT count(*) n FROM messages WHERE itemId LIKE ?")
          .get(`notify:${runId}:%`),
      ).n;
  }
  previousEvent(id: string, key: string) {
    return this.db
      .prepare(
        "SELECT id,payloadHash,runId,conversationId FROM routine_events WHERE routineId=? AND triggerKey=?",
      )
      .get(id, key);
  }
  recentWebhooks(id: string, now: number) {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) n FROM routine_events WHERE routineId=? AND source='webhook' AND createdAt>?",
        )
        .get(id, now - 60000)?.n,
    );
  }
  queuedWebhook(routine: Routine) {
    return this.db
      .prepare(
        `SELECT e.runId,r.conversationId FROM routine_events e JOIN runs r ON r.id=e.runId
      WHERE e.routineId=? AND e.source='webhook' AND e.definitionRevision=?
      AND r.status='queued' ORDER BY e.sequence DESC LIMIT 1`,
      )
      .get(routine.id, routine.revision);
  }
  inputSize(runId: string) {
    return Number(
      this.db
        .prepare(
          "SELECT COALESCE(sum(length(text)),0) n FROM messages WHERE runId=? AND role='user'",
        )
        .get(runId)?.n,
    );
  }
  appendInput(
    botId: string,
    run: { id: string; conversationId: string },
    text: string,
    now: number,
  ) {
    this.db
      .prepare(
        "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId) VALUES(?,?,?,'user',?,?,?)",
      )
      .run(randomUUID(), botId, run.conversationId, text, now, run.id);
  }
  hasActiveRun(id: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM routine_events e JOIN runs r ON r.id=e.runId WHERE e.routineId=? AND r.status IN('queued','running','cancelling') LIMIT 1",
      )
      .get(id);
  }
  queueSize() {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) n FROM runs WHERE status IN('queued','running','cancelling')",
        )
        .get()?.n,
    );
  }
  recordEvent(
    id: string,
    routine: Routine,
    trigger: {
      source: string;
      key: string;
      now: number;
      scheduledAt: number | null;
    },
    hash: string,
    run: { id: string; conversationId: string } | undefined,
    error: string | null,
  ) {
    this.db
      .prepare(
        "INSERT INTO routine_events(id,routineId,source,triggerKey,payloadHash,createdAt,scheduledAt,coveredUntil,definitionRevision,name,prompt,runId,conversationId,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        routine.id,
        trigger.source,
        trigger.key,
        hash,
        trigger.now,
        trigger.scheduledAt,
        trigger.source === "schedule" ? trigger.now : null,
        routine.revision,
        routine.name,
        routine.prompt,
        run?.id ?? null,
        run?.conversationId ?? null,
        error,
      );
  }
  due(now: number) {
    return this.db
      .prepare(
        "SELECT r.* FROM routines r JOIN bots b ON b.id=r.botId WHERE r.state='active' AND r.nextAt<=? AND b.lifecycle='active' ORDER BY r.nextAt,r.id LIMIT 32",
      )
      .all(now)
      .map((row) => this.parse(row));
  }
  advance(id: string, next: number | null, error: string | null) {
    this.db
      .prepare("UPDATE routines SET nextAt=?,error=? WHERE id=?")
      .run(next, error, id);
  }
}
