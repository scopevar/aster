import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { StreamEntry } from "./stream-entry.js";
import { AppError } from "../../shared/core.js";
import { toolSchema, type ToolExecution } from "../../shared/chat/messages.js";
import { type Job } from "../job.js";
type Context = {
  transaction<T>(fn: () => T): T;
  changed(): void;
  canWrite(job: Job): boolean;
};
export class RunOutputStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly context: Context,
  ) {}
  writeText(job: Job, itemId: string, text: string, complete: boolean) {
    this.writeStream(job, [{ kind: "text", itemId, text, replace: complete }]);
  }
  writeStream(job: Job, entries: readonly StreamEntry[]) {
    if (!entries.length) return;
    // [Invariant]: 迟到的增量不得写入已结束或已取消的运行，故每次刷写都重新校验授权。
    let failure: unknown;
    this.context.transaction(() => {
      if (!this.context.canWrite(job)) return;
      for (const entry of entries) {
        try {
          if (entry.kind === "text")
            this.putText(job, entry.itemId, entry.text, entry.replace);
          else this.appendOutput(job, entry.itemId, entry.delta);
        } catch (error) {
          // 已处理的条目随本事务提交，与逐条写入时“先落库再报错”的语义一致。
          failure = error;
          break;
        }
      }
      this.context.changed();
    });
    if (failure !== undefined) throw failure;
  }
  private putText(job: Job, itemId: string, text: string, replace: boolean) {
    const updated = this.db
      .prepare(
        replace
          ? "UPDATE messages SET text=? WHERE runId=? AND itemId=?"
          : "UPDATE messages SET text=text||? WHERE runId=? AND itemId=?",
      )
      .run(text, job.id, itemId);
    if (updated.changes) return;
    this.db
      .prepare(
        "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId,itemId) VALUES(?,?,?,'assistant',?,?,?,?)",
      )
      .run(
        randomUUID(),
        job.botId,
        job.conversationId,
        text,
        Date.now(),
        job.id,
        itemId,
      );
  }
  private appendOutput(job: Job, itemId: string, delta: string) {
    const row = this.db
      .prepare("SELECT id,toolJson FROM messages WHERE runId=? AND itemId=?")
      .get(job.id, itemId);
    if (!row)
      throw new AppError("unknown", "工具输出缺少对应调用，不能确定执行状态。");
    const tool = toolSchema.parse(JSON.parse(z.string().parse(row.toolJson)));
    if (tool.status !== "running" || tool.truncated) return;
    const output = tool.output + delta;
    tool.output = output.slice(0, 65536);
    tool.truncated = output.length > 65536;
    this.db
      .prepare("UPDATE messages SET toolJson=? WHERE id=?")
      .run(JSON.stringify(tool), z.string().parse(row.id));
  }
  writeTool(job: Job, itemId: string, tool: ToolExecution) {
    this.context.transaction(() => {
      if (!this.context.canWrite(job)) return;
      const old = this.db
        .prepare("SELECT id,toolJson FROM messages WHERE runId=? AND itemId=?")
        .get(job.id, itemId);
      if (old) {
        const previous = toolSchema.parse(
          JSON.parse(z.string().parse(old.toolJson)),
        );
        if (previous.command !== tool.command || previous.cwd !== tool.cwd)
          throw new AppError(
            "unknown",
            "同一工具调用的参数发生变化，执行结果需要核实。",
          );
        if (previous.status !== "running") return;
        if (tool.status === "running") return;
        this.db
          .prepare("UPDATE messages SET toolJson=? WHERE id=?")
          .run(JSON.stringify(tool), z.string().parse(old.id));
      } else {
        const count = z
          .object({ n: z.number() })
          .parse(
            this.db
              .prepare(
                "SELECT count(*) AS n FROM messages WHERE runId=? AND toolJson IS NOT NULL",
              )
              .get(job.id),
          ).n;
        if (count >= 1000)
          throw new AppError(
            "unknown",
            "单次运行工具调用达到记录上限，已停止等待并保留已记录结果。",
          );
        this.db
          .prepare(
            "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId,itemId,toolJson) VALUES(?,?,?,'assistant',?,?,?,?,?)",
          )
          .run(
            randomUUID(),
            job.botId,
            job.conversationId,
            "执行命令",
            Date.now(),
            job.id,
            itemId,
            JSON.stringify(tool),
          );
      }
      this.context.changed();
    });
  }
  appendToolOutput(job: Job, itemId: string, delta: string) {
    this.writeStream(job, [{ kind: "tool-output", itemId, delta }]);
  }
}
