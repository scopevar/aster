import { randomUUID, createHash } from "node:crypto";
import { AppError } from "../shared/core.js";
import { type Run } from "../shared/chat/runs.js";
import {
  routineToolRequestSchema,
  routineSummarySchema,
  routineToolResultSchema,
  type RoutineOperation,
  type RoutineToolResult,
  type RoutineCommand,
  type RoutineReceipt,
} from "../shared/routines.js";
import { routineReceiptText } from "../presentation/routine-text.js";
import type { Job } from "../storage/job.js";
import type { RoutineService } from "./service.js";
import type { MessageStorage } from "../storage/chat/messages.js";
const maxCallsPerTurn = 24;
const maxAuditBytes = 64 * 1024 * 1024;
type Enqueue = (
  botId: string,
  text: string,
) => { id: string; conversationId: string };
type Context = {
  routines: RoutineService;
  messages: Pick<MessageStorage, "appendRoutineReceipt">;
  canWrite(job: Job): boolean;
  getRun(id: string): Run | undefined;
  transaction<T>(fn: () => T): T;
  changed(): void;
  enqueue: Enqueue;
};
/** Tool authorization, replay and quotas are checked inside the owner's synchronous transaction. */
export class RoutineTools {
  constructor(private readonly context: Context) {}
  notify(job: Job, callId: string, text: string) {
    return this.context.routines.notify(job, callId, text);
  }
  request(job: Job, value: unknown) {
    const request = routineToolRequestSchema.parse(value);
    return this.context.transaction(() => {
      if (
        !this.context.canWrite(job) ||
        this.context.getRun(job.id)?.status !== "running"
      )
        throw new AppError("unauthorized", "运行已结束，不能继续访问任务。");
      const result = this.perform(
        job,
        request.callId,
        request.operation,
        this.context.enqueue,
      );
      this.context.changed();
      return result;
    });
  }
  private perform(
    job: Job,
    callId: string,
    operation: RoutineOperation,
    enqueue: Enqueue,
  ): RoutineToolResult {
    if (
      job.groupOrdinal !== undefined ||
      this.context.routines.calls.isAutomatic(job.id)
    )
      throw new AppError(
        "unauthorized",
        "请在用户发起的 Bot 私聊中管理例行任务；群聊和自动运行不能修改或读取私有任务。",
      );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(operation))
      .digest("hex");
    const old = this.context.routines.calls.find(job.id, callId);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new AppError("conflict", "同一任务工具调用不能改变参数。");
      return old.result;
    }
    if (this.context.routines.calls.count(job.id) >= maxCallsPerTurn)
      throw new AppError("capacity", "每回合最多 24 次任务工具调用。");
    let result: RoutineToolResult;
    let receipt: RoutineReceipt | null = null;
    let messageId: string | null = null;
    if (operation.action === "list")
      result = {
        action: "list",
        routines: this.context.routines
          .view({ botId: job.botId })
          .routines.filter((r) => r.state !== "deleted")
          .map((r) => routineSummarySchema.parse(r)),
      };
    else {
      const id = operation.action === "create" ? randomUUID() : operation.id;
      const current =
        operation.action === "create" ? null : this.context.routines.get(id);
      if (current && current.botId !== job.botId)
        throw new AppError("unauthorized", "任务不属于当前 Bot。");
      if (operation.action === "read")
        result = { action: "read", routine: this.context.routines.get(id) };
      else {
        let command: RoutineCommand;
        if (operation.action === "create" || operation.action === "update")
          command = {
            type: "routine.save",
            id,
            botId: job.botId,
            revision: operation.action === "create" ? 0 : operation.revision,
            name: operation.name,
            prompt: operation.prompt,
            schedule: operation.schedule,
            enabled: operation.enabled,
          };
        else
          command = {
            type: "routine.state",
            id,
            botId: job.botId,
            revision: operation.revision,
            state: operation.action === "pause" ? "paused" : "deleted",
          };
        this.context.routines.execute(command, enqueue, Date.now());
        const routine = routineSummarySchema.parse(
          this.context.routines.get(id),
        );
        messageId = randomUUID();
        receipt = { action: operation.action, routine };
        this.context.messages.appendRoutineReceipt(
          job,
          messageId,
          routineReceiptText(receipt),
        );
        result = { action: operation.action, routine, messageId };
      }
    }
    const checked = routineToolResultSchema.parse(result),
      json = JSON.stringify(checked);
    if (
      this.context.routines.calls.bytes() + Buffer.byteLength(json) >
      maxAuditBytes
    )
      throw new AppError("capacity", "任务工具审计已达 64 MiB，修改未提交。");
    this.context.routines.calls.record(
      job.id,
      callId,
      fingerprint,
      checked,
      receipt,
    );
    return checked;
  }
}
