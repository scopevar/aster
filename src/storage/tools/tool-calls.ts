import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  computerToolSchema,
  actionName,
  type ComputerTool,
  type toolDecisionSchema,
} from "../../shared/tools/tool-calls.js";
import {
  conditionRuleSchema,
  reviewViewSchema,
  type ScriptApprovalDecision,
} from "../../shared/tools/approval-conditions.js";
import type { ScriptAction } from "../../shared/tools/scripts.js";
import type { Job } from "../store.js";

/** All mutations run inside Store's transaction. The row is committed before any external input. */
export class ToolCallStorage {
  constructor(private readonly db: DatabaseSync) {}
  migrate() {
    this.db.exec(`CREATE TABLE computer_calls(
      id TEXT PRIMARY KEY,messageId TEXT UNIQUE NOT NULL REFERENCES messages(id),runId TEXT NOT NULL REFERENCES runs(id),
      botId TEXT NOT NULL REFERENCES bots(id),conversationId TEXT NOT NULL REFERENCES conversations(id),ordinal INTEGER NOT NULL,
      callId TEXT NOT NULL,actionJson TEXT NOT NULL,generation INTEGER NOT NULL,controlRevision INTEGER NOT NULL,
      status TEXT NOT NULL,detail TEXT NOT NULL,expiresAt INTEGER NOT NULL,image BLOB,
      UNIQUE(runId,ordinal,callId));
      CREATE UNIQUE INDEX computer_input_owner ON computer_calls(botId) WHERE status IN ('running','cancelling');
      CREATE INDEX computer_call_run ON computer_calls(runId,status);`);
  }
  private parse(row: unknown): ComputerTool {
    const raw = z
      .object({ actionJson: z.string(), hasImage: z.number() })
      .passthrough()
      .parse(row);
    const { actionJson, hasImage, ...rest } = raw;
    return computerToolSchema.parse({
      ...rest,
      action: JSON.parse(actionJson),
      hasImage: !!hasImage,
      review: this.reviewView(z.string().parse(rest.id)),
    });
  }
  private reviewView(id: string) {
    const row = this.db
      .prepare(
        "SELECT state,decision,reason,inputJson FROM approval_reviews WHERE callId=?",
      )
      .get(id);
    if (!row) return null;
    const input = z
      .object({
        conditions: z.array(conditionRuleSchema).max(32),
        jev: z
          .object({ confidence: z.number().min(0).max(1).optional() })
          .optional(),
      })
      .parse(JSON.parse(z.string().parse(row.inputJson)));
    return reviewViewSchema.parse({
      state: row.state,
      decision: row.decision,
      reason: row.reason,
      ...(input.jev ? { reviewer: "jev" } : {}),
      ...(input.jev?.confidence === undefined
        ? {}
        : { confidence: input.jev.confidence }),
      rules: input.conditions.map(({ condition, decision }) => ({
        condition,
        decision,
      })),
    });
  }
  private select =
    "SELECT id,botId,conversationId,runId,actionJson,generation,controlRevision,status,detail,expiresAt,image IS NOT NULL AS hasImage FROM computer_calls";
  get(id: string) {
    const row = this.db.prepare(`${this.select} WHERE id=?`).get(id);
    if (!row) throw new AppError("not_found", "工具调用不存在。");
    return this.parse(row);
  }
  forMessage(id: string) {
    const row = this.db.prepare(`${this.select} WHERE messageId=?`).get(id);
    return row ? this.parse(row) : null;
  }
  request(job: Job, callId: string, action: ScriptAction) {
    const old = this.db
      .prepare(
        "SELECT id,actionJson FROM computer_calls WHERE runId=? AND ordinal=? AND callId=?",
      )
      .get(job.id, job.groupOrdinal ?? -1, callId);
    const body = JSON.stringify(action);
    if (old) {
      if (old.actionJson !== body)
        throw new AppError("conflict", "同一工具调用不能改变参数。");
      return this.get(z.string().parse(old.id));
    }
    const count = z
      .object({ n: z.number() })
      .parse(
        this.db
          .prepare("SELECT count(*) AS n FROM computer_calls WHERE runId=?")
          .get(job.id),
      ).n;
    if (count >= 100)
      throw new AppError("capacity", "单次运行工具调用已达 100 次上限。");
    const id = randomUUID(),
      messageId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId,itemId) VALUES(?,?,?,'assistant',?,?,?,?)",
      )
      .run(
        messageId,
        job.botId,
        job.conversationId,
        actionName(action),
        Date.now(),
        job.id,
        `computer:${id}`,
      );
    this.db
      .prepare(
        "INSERT INTO computer_calls(id,messageId,runId,botId,conversationId,ordinal,callId,actionJson,generation,controlRevision,status,detail,expiresAt,image,policyRevision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)",
      )
      .run(
        id,
        messageId,
        job.id,
        job.botId,
        job.conversationId,
        job.groupOrdinal ?? -1,
        callId,
        body,
        0,
        0,
        "pending",
        action.network.length
          ? `等待批准本次 Linux 脚本及 HTTPS 范围：${action.network.join(", ")}。`
          : "等待批准本次 Linux 隔离脚本，禁止访问网络。",
        Date.now() + 5 * 60 * 1000,
        0,
      );
    return this.get(id);
  }
  decide(command: z.infer<typeof toolDecisionSchema>) {
    const call = this.get(command.id);
    if (call.conversationId !== command.conversationId)
      throw new AppError("unauthorized", "不能批准其他会话中的调用。");
    if (call.action.type !== "script")
      throw new AppError("conflict", "电脑环境已弃用，旧审批不能继续执行。");
    if (call.status !== "pending" || call.expiresAt <= Date.now())
      throw new AppError("conflict", "这次审批已经结束或过期。");
    if (
      !this.db
        .prepare("SELECT 1 FROM runs WHERE id=? AND status='running'")
        .get(call.runId)
    )
      throw new AppError("conflict", "运行已结束或正在取消，不能再批准操作。");
    this.db
      .prepare(
        "UPDATE computer_calls SET status=?,detail=?,manualDecision=1 WHERE id=? AND status='pending'",
      )
      .run(
        command.decision === "allow" ? "approved" : "declined",
        command.decision === "allow"
          ? "已允许一次，等待执行。"
          : "你拒绝了这次操作，未执行。",
        call.id,
      );
    this.db
      .prepare(
        "UPDATE approval_reviews SET state='manual',decision=?,reason=? WHERE callId=?",
      )
      .run(
        command.decision === "allow" ? "allow" : "deny",
        command.decision === "allow"
          ? "已由你允许本次脚本。"
          : "已由你拒绝本次脚本。",
        call.id,
      );
    return { id: call.id };
  }
  startReview(id: string) {
    const call = this.get(id);
    if (call.status !== "pending" || call.review) return;
    this.db
      .prepare(
        "INSERT INTO approval_reviews(callId,revision,inputJson,state,decision,reason,ruleIdsJson) VALUES(?,0,?,'reviewing',NULL,?,'[]')",
      )
      .run(
        id,
        JSON.stringify({ conditions: [], jev: {} }),
        "Jev 正在审核本次脚本与联网范围。",
      );
    this.db
      .prepare(
        "UPDATE computer_calls SET detail=? WHERE id=? AND status='pending'",
      )
      .run("Jev 正在审核，脚本尚未执行。", id);
  }
  reviewRequests(job: Job) {
    const rows = this.db
      .prepare(
        "SELECT text FROM messages WHERE runId=? AND conversationId=? AND role='user' ORDER BY sequence LIMIT 101",
      )
      .all(job.id, job.conversationId);
    if (rows.length > 100)
      throw new AppError("capacity", "本轮指令超过自动审核范围，请人工确认。");
    return rows.map((row) => z.string().parse(row.text));
  }
  finishReview(id: string, result: ScriptApprovalDecision) {
    const call = this.get(id);
    if (call.status !== "pending" || call.review?.state !== "reviewing") return;
    if (call.expiresAt <= Date.now()) {
      this.finish(id, "expired", "本次脚本审批已过期，未执行。");
      return;
    }
    const changed = this.db
      .prepare(
        "UPDATE computer_calls SET status=?,detail=? WHERE id=? AND status='pending' AND manualDecision=0",
      )
      .run(
        result.decision === "allow" ? "approved" : "pending",
        result.reason,
        id,
      );
    if (!changed.changes) return;
    this.db
      .prepare(
        "UPDATE approval_reviews SET state='decided',decision=?,reason=?,inputJson=? WHERE callId=? AND state='reviewing'",
      )
      .run(
        result.decision,
        result.reason,
        JSON.stringify({
          conditions: [],
          jev: { confidence: result.confidence },
        }),
        id,
      );
  }
  claim(id: string) {
    const call = this.get(id);
    if (call.status !== "approved") return null;
    if (call.expiresAt <= Date.now()) {
      this.finish(id, "expired", "审批已过期，未执行。");
      return null;
    }
    if (call.action.type !== "script") {
      this.finish(id, "cancelled", "电脑环境已弃用，旧操作不会执行。");
      return null;
    }
    if (
      this.db
        .prepare(
          "SELECT 1 FROM computer_calls WHERE botId=? AND status IN ('running','cancelling')",
        )
        .get(call.botId)
    )
      return null;
    this.db
      .prepare(
        "UPDATE computer_calls SET status='running',detail='正在执行已批准的隔离脚本…' WHERE id=? AND status='approved'",
      )
      .run(id);
    return this.get(id);
  }
  cancel(id: string) {
    const call = this.get(id);
    if (["pending", "approved"].includes(call.status))
      this.finish(id, "cancelled", "操作已取消，未执行。");
    else if (call.status === "running")
      this.db
        .prepare(
          "UPDATE computer_calls SET status='cancelling',detail='正在停止隔离脚本…' WHERE id=?",
        )
        .run(id);
  }
  finish(id: string, status: ComputerTool["status"], detail: string) {
    this.db
      .prepare(
        "UPDATE computer_calls SET status=?,detail=? WHERE id=? AND status IN ('pending','approved','running','cancelling')",
      )
      .run(status, detail.slice(0, 1000), id);
    if (["cancelled", "expired", "failed", "unknown"].includes(status))
      this.db
        .prepare(
          "UPDATE approval_reviews SET state='abandoned',decision='ask',reason=? WHERE callId=? AND state='reviewing'",
        )
        .run("本次审核已结束，迟到结果不会生效。", id);
  }
  image(id: string, conversationId: string) {
    const call = this.get(id);
    if (call.conversationId !== conversationId)
      throw new AppError("unauthorized", "截图不属于这个会话。");
    const row = z
      .object({ image: z.instanceof(Uint8Array) })
      .safeParse(
        this.db.prepare("SELECT image FROM computer_calls WHERE id=?").get(id),
      );
    if (!row.success) throw new AppError("not_found", "这次调用没有截图。");
    return {
      mime: "image/png" as const,
      data: Buffer.from(row.data.image).toString("base64"),
    };
  }
  recover() {
    this.db.exec(
      "UPDATE approval_reviews SET state='abandoned',decision='ask',reason='后台中断，未完成的自动审核不会继续执行。' WHERE state='reviewing'",
    );
    this.db.exec(
      "UPDATE computer_calls SET status=CASE WHEN status IN ('running','cancelling') THEN 'unknown' ELSE 'cancelled' END,detail='后台曾中断，旧审批和调用不会自动重放。' WHERE status IN ('pending','approved','running','cancelling')",
    );
  }
  finishRun(runId: string) {
    this.db
      .prepare(
        "UPDATE approval_reviews SET state='abandoned',decision='ask',reason='运行已结束，迟到审核结果不会生效。' WHERE state='reviewing' AND callId IN (SELECT id FROM computer_calls WHERE runId=?)",
      )
      .run(runId);
    this.db
      .prepare(
        "UPDATE computer_calls SET status=CASE WHEN status IN ('running','cancelling') THEN 'unknown' ELSE 'cancelled' END,detail='运行已经结束，未完成的旧操作不会重放。' WHERE runId=? AND status IN ('pending','approved','running','cancelling')",
      )
      .run(runId);
  }
}
