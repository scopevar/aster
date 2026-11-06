import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  pluginCallSchema,
  type PluginCall,
  type PluginToolRequest,
} from "../../shared/tools/plugins.js";
import type { Job } from "../job.js";
import type { UserNoticeStorage } from "../chat/notices.js";

type CallOperation = Extract<
  PluginToolRequest["operation"],
  { action: "call" }
>;
export class PluginCallStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: {
      transaction<T>(fn: () => T): T;
      canWrite(job: Job): boolean;
      requireBot(id: string): void;
    },
    private readonly notices: UserNoticeStorage,
  ) {}
  migrate() {
    this.db.exec(`CREATE TABLE plugin_calls(
      id TEXT PRIMARY KEY, botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      pluginId TEXT NOT NULL, pluginName TEXT NOT NULL, server TEXT NOT NULL, tool TEXT NOT NULL,
      argumentsJson TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
      runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, callId TEXT NOT NULL,
      messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, resultJson TEXT,
      UNIQUE(runId,callId));`);
  }
  private parse(row: unknown): PluginCall {
    const raw = z
      .object({ argumentsJson: z.string() })
      .passthrough()
      .parse(row);
    return pluginCallSchema.parse({
      id: raw.id,
      botId: raw.botId,
      pluginId: raw.pluginId,
      pluginName: raw.pluginName,
      server: raw.server,
      tool: raw.tool,
      status: raw.status,
      detail: raw.detail,
      arguments: JSON.parse(raw.argumentsJson),
    });
  }
  get(id: string) {
    const row = this.db
      .prepare("SELECT * FROM plugin_calls WHERE id=?")
      .get(id);
    if (!row) throw new AppError("not_found", "插件工具调用不存在。");
    return this.parse(row);
  }
  forMessage(id: string) {
    const row = this.db
      .prepare("SELECT * FROM plugin_calls WHERE messageId=?")
      .get(id);
    return row ? this.parse(row) : null;
  }
  create(
    job: Job,
    callId: string,
    pluginName: string,
    operation: CallOperation,
  ) {
    return this.owner.transaction(() => {
      if (job.groupOrdinal !== undefined || !this.owner.canWrite(job))
        throw new AppError(
          "unauthorized",
          "插件工具只允许在当前 Bot 的有效私聊运行中使用。",
        );
      const previous = this.db
        .prepare("SELECT * FROM plugin_calls WHERE runId=? AND callId=?")
        .get(job.id, callId);
      if (previous) {
        const old = this.parse(previous);
        if (
          old.pluginId !== operation.pluginId ||
          old.server !== operation.server ||
          old.tool !== operation.tool ||
          JSON.stringify(old.arguments) !== JSON.stringify(operation.arguments)
        )
          throw new AppError("conflict", "同一插件调用不能更换内容。");
        return old;
      }
      const count = z
        .number()
        .parse(
          this.db
            .prepare("SELECT count(*) n FROM plugin_calls WHERE runId=?")
            .get(job.id)?.n,
        );
      if (count >= 32)
        throw new AppError("capacity", "本轮插件调用次数超过限制。");
      const id = randomUUID(),
        text = `插件工具：${pluginName} / ${operation.server} / ${operation.tool}`;
      // A routine run lives in a hidden conversation. Put its approval card in
      // the visible private chat so the user is actually asked before the tool runs.
      const routine = !!this.db
        .prepare("SELECT 1 FROM routine_events WHERE runId=? LIMIT 1")
        .get(job.id);
      const messageId = routine
        ? this.notices.append(
            job.botId,
            text,
            `plugin-approval:${job.id}:${callId}`,
          ).messageId
        : randomUUID();
      if (!routine)
        this.db
          .prepare(
            "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId,itemId) VALUES(?,?,?,'assistant',?,?,?,?)",
          )
          .run(
            messageId,
            job.botId,
            job.conversationId,
            text,
            Date.now(),
            job.id,
            `plugin:${id}`,
          );
      this.db
        .prepare(
          "INSERT INTO plugin_calls(id,botId,pluginId,pluginName,server,tool,argumentsJson,status,runId,callId,messageId) VALUES(?,?,?,?,?,?,?,'pending',?,?,?)",
        )
        .run(
          id,
          job.botId,
          operation.pluginId,
          pluginName,
          operation.server,
          operation.tool,
          JSON.stringify(operation.arguments),
          job.id,
          callId,
          messageId,
        );
      return this.get(id);
    });
  }
  decide(
    botId: string,
    id: string,
    allow: boolean,
    persistReceipt?: () => void,
  ) {
    this.owner.requireBot(botId);
    this.owner.transaction(() => {
      const call = this.get(id);
      if (call.botId !== botId)
        throw new AppError("unauthorized", "调用不属于这个 Bot。");
      const active = this.db
        .prepare(
          "SELECT 1 FROM plugin_calls c JOIN runs r ON r.id=c.runId JOIN plugins p ON p.id=c.pluginId AND p.botId=c.botId WHERE c.id=? AND r.status='running' AND p.enabled=1",
        )
        .get(id);
      if (call.status !== "pending" || !active)
        throw new AppError("conflict", "调用已结束或插件已停用。");
      this.db
        .prepare("UPDATE plugin_calls SET status=?,detail=? WHERE id=?")
        .run(
          allow ? "approved" : "declined",
          allow ? "用户已批准。" : "用户已拒绝，未执行。",
          id,
        );
      persistReceipt?.();
    });
  }
  claim(job: Job, id: string) {
    return this.owner.transaction(() => {
      if (!this.owner.canWrite(job)) return false;
      return (
        this.db
          .prepare(
            "UPDATE plugin_calls SET status='running',detail='正在执行。' WHERE id=? AND runId=? AND botId=? AND status='approved' AND EXISTS(SELECT 1 FROM plugins WHERE id=plugin_calls.pluginId AND botId=? AND enabled=1)",
          )
          .run(id, job.id, job.botId, job.botId).changes === 1
      );
    });
  }
  finish(
    id: string,
    status: PluginCall["status"],
    detail: string,
    result?: unknown,
  ) {
    this.owner.transaction(() =>
      this.db
        .prepare(
          "UPDATE plugin_calls SET status=?,detail=?,resultJson=? WHERE id=? AND status IN ('pending','approved','running')",
        )
        .run(
          status,
          detail.slice(0, 1000),
          result === undefined ? null : JSON.stringify(result),
          id,
        ),
    );
  }
  result(id: string): unknown {
    const row = this.db
      .prepare("SELECT resultJson FROM plugin_calls WHERE id=?")
      .get(id);
    return row?.resultJson
      ? JSON.parse(z.string().parse(row.resultJson))
      : { status: this.get(id).status, detail: this.get(id).detail };
  }
  recover() {
    this.db
      .prepare(
        "UPDATE plugin_calls SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'cancelled' END,detail='运行已结束，不会自动重放。' WHERE status IN ('pending','approved','running')",
      )
      .run();
  }
}
