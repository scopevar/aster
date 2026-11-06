import type { RoutineRepository } from "./repository.js";
import { routineContext, routineInput } from "./prompts.js";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "../shared/core.js";
import { type RunStatus } from "../shared/chat/runs.js";
import {
  type Routine,
  type RoutineCommand,
  type RoutineQuery,
  type WebhookInput,
} from "../shared/routines.js";
import {
  nextRoutineTime,
  resolveRoutineSchedule,
  routineFollowUpTime,
  routineStartTime,
} from "./schedule.js";
import type { UserNoticeStorage } from "../storage/chat/notices.js";
import type { Job } from "../storage/job.js";

type Enqueue = (
  botId: string,
  text: string,
) => { id: string; conversationId: string };
/** Store owns the transaction, including cursor advancement and the enqueue callback. */
export class RoutineService {
  constructor(
    readonly repository: RoutineRepository,
    private readonly notices: Pick<UserNoticeStorage, "append">,
  ) {}

  get calls() {
    return this.repository.calls;
  }
  get(id: string) {
    return this.repository.get(id);
  }
  view(query: RoutineQuery) {
    return this.repository.view(query);
  }
  event(id: string, routineId: string) {
    return this.repository.event(id, routineId);
  }
  isRun(runId: string) {
    return this.repository.isRun(runId);
  }
  /** Successful scheduled one-time runs retire themselves; failures stay inspectable. */
  completeRun(runId: string, status: RunStatus) {
    for (const row of this.repository.scheduledOneTimeRuns(runId)) {
      const id = z.string().parse(row.id);
      if (status === "completed") this.repository.retire(id);
      else if (["failed", "cancelled", "unknown"].includes(status))
        this.repository.completionError(
          id,
          "一次性任务运行未成功，请查看运行记录后重试或删除。",
        );
    }
  }
  context(botId: string) {
    return routineContext(this.repository.context(botId));
  }
  execute(command: RoutineCommand, enqueue: Enqueue, now: number) {
    this.repository.activeBot(command.botId);
    const existing = this.repository.find(command.id);
    if (!existing) {
      if (command.type !== "routine.save" || command.revision !== 0)
        throw new AppError("not_found", "例行任务已不存在，请刷新。");
      const count = this.repository.count(command.botId);
      if (count.total >= 512 || count.own >= 64)
        throw new AppError(
          "capacity",
          "例行任务数量已达上限（每 Bot 64、全局 512）。",
        );
      const schedule = resolveRoutineSchedule(command.schedule, now);
      const next = nextRoutineTime(schedule, now);
      const state = command.enabled === false ? "paused" : "active";
      this.repository.create(
        {
          id: command.id,
          botId: command.botId,
          name: command.name,
          prompt: command.prompt,
          schedule,
          state,
          nextAt: state === "active" ? next : null,
          revision: 1,
          createdAt: now,
          hasKey: false,
          error: null,
        },
        now,
      );
      return { id: command.id, revision: 1 };
    }
    const current = existing.routine;
    if (current.botId !== command.botId)
      throw new AppError("unauthorized", "任务不属于当前 Bot。");
    if (current.revision !== command.revision || current.state === "deleted")
      throw new AppError("conflict", "任务已更改或删除，请刷新后重试。");
    if (command.type === "routine.test") {
      const fired = this.fire(
        current,
        {
          source: "manual",
          key: `manual:${randomUUID()}`,
          payload: "",
          scheduledAt: null,
          now,
        },
        enqueue,
      );
      // The event history carries whether this test was skipped; the command
      // result stays within the persisted CommandResult shape so replay is stable.
      return {
        id: fired.id,
        ...(fired.conversationId
          ? { conversationId: fired.conversationId }
          : {}),
      };
    }
    if (command.type === "routine.save") {
      const schedule = resolveRoutineSchedule(command.schedule, now);
      const next = nextRoutineTime(schedule, now);
      const state =
        command.enabled === undefined
          ? current.schedule.kind === schedule.kind
            ? current.state
            : "paused"
          : command.enabled
            ? "active"
            : "paused";
      this.repository.update({
        ...current,
        name: command.name,
        prompt: command.prompt,
        schedule,
        state,
        nextAt: state === "active" ? next : null,
      });
    } else if (command.type === "routine.key") {
      if (current.schedule.kind !== "webhook")
        throw new AppError("invalid_input", "只有 Webhook 任务需要密钥。");
      this.repository.key(current.id, command.hash);
    } else {
      if (
        command.state === "active" &&
        current.schedule.kind === "webhook" &&
        !current.hasKey
      )
        throw new AppError("conflict", "请先生成 Webhook 密钥。");
      this.repository.setState(
        current.id,
        command.state,
        command.state === "active"
          ? routineStartTime(current.schedule, now)
          : null,
      );
    }
    return { id: current.id, revision: current.revision + 1 };
  }

  notify(job: Job, callId: string, text: string, now = Date.now()) {
    if (job.groupOrdinal !== undefined)
      throw new AppError("unauthorized", "群聊运行不能向私聊发送通知。");
    if (!this.isRun(job.id))
      throw new AppError(
        "unauthorized",
        "只有后台例行运行可以发送通知；普通对话直接回复即可。",
      );
    const run = this.repository.notificationRun(job.id, job.botId);
    if (run?.status !== "running")
      throw new AppError("unauthorized", "运行已结束，不能继续发送通知。");
    const content = text.trim();
    if (!content || content.includes("\0"))
      throw new AppError("invalid_input", "通知内容不能为空。");
    const itemId = `notify:${job.id}:${callId}`;
    const old = this.repository.notification(itemId);
    if (old)
      return {
        status: "sent" as const,
        messageId: z.string().parse(old.id),
        conversationId: z.string().parse(old.conversationId),
      };
    const count = this.repository.notificationCount(job.id);
    if (count >= 8)
      throw new AppError("capacity", "本次例行运行最多发送 8 条通知。");
    return {
      status: "sent" as const,
      ...this.notices.append(job.botId, content, itemId, now),
    };
  }

  private fire(
    routine: Routine,
    trigger: {
      source: "manual" | "schedule" | "webhook";
      key: string;
      payload: string;
      scheduledAt: number | null;
      now: number;
      queue?: boolean;
    },
    enqueue: Enqueue,
  ) {
    const hash = createHash("sha256").update(trigger.payload).digest("hex");
    const old = this.repository.previousEvent(routine.id, trigger.key);
    if (old) {
      if (old.payloadHash !== hash)
        throw new AppError("conflict", "事件编号已用于其他内容，未重复执行。");
      return {
        id: z.string().parse(old.id),
        error: null,
        ...(typeof old.conversationId === "string"
          ? { conversationId: old.conversationId }
          : {}),
      };
    }
    if (
      trigger.source === "webhook" &&
      this.repository.recentWebhooks(routine.id, trigger.now) >= 30
    )
      throw new AppError("capacity", "Webhook 每分钟最多接收 30 个新事件。");
    let error: string | null = null;
    let run: { id: string; conversationId: string } | undefined;
    // Keep at most one queued webhook run per routine definition and append
    // later payloads to it, so a burst of important events is not dropped.
    if (trigger.source === "webhook") {
      const queued = this.repository.queuedWebhook(routine);
      if (queued) {
        const queuedRunId = z.string().parse(queued.runId),
          queuedConversationId = z.string().parse(queued.conversationId),
          text = routineInput(routine, trigger),
          used = this.repository.inputSize(queuedRunId);
        if (used + text.length <= 128 * 1024) {
          run = { id: queuedRunId, conversationId: queuedConversationId };
          this.repository.appendInput(routine.botId, run, text, trigger.now);
        }
      }
    }
    if (!run) {
      if (
        trigger.source !== "webhook" &&
        !trigger.queue &&
        this.repository.hasActiveRun(routine.id)
      )
        error = "上一次运行尚未结束，本次触发已跳过。";
      else if (this.repository.queueSize() >= 100)
        error = "全局等待队列已满，本次触发已跳过。";
      else run = enqueue(routine.botId, routineInput(routine, trigger));
    }
    const id = randomUUID();
    this.repository.recordEvent(id, routine, trigger, hash, run, error);
    return {
      id,
      error,
      ...(run ? { conversationId: run.conversationId } : {}),
    };
  }
  tick(now: number, enqueue: Enqueue) {
    const due = this.repository.due(now);
    for (const routine of due) {
      const next = routineFollowUpTime(routine.schedule, now);
      const fired = this.fire(
        routine,
        {
          source: "schedule",
          key: `schedule:${routine.nextAt}`,
          payload: "",
          scheduledAt: routine.nextAt,
          now,
          queue: routine.schedule.kind === "at",
        },
        enqueue,
      );
      this.repository.advance(
        routine.id,
        next,
        routine.schedule.kind === "at" ? fired.error : null,
      );
    }
    return due.length;
  }
  authenticate(id: string, token: string) {
    const row = this.repository.find(id);
    const digest = createHash("sha256").update(token).digest();
    const expected =
      typeof row?.keyHash === "string"
        ? Buffer.from(row.keyHash, "hex")
        : Buffer.alloc(32);
    if (
      !row ||
      !row.keyHash ||
      expected.length !== digest.length ||
      !timingSafeEqual(expected, digest)
    )
      throw new AppError("unauthorized", "Webhook 认证失败。");
    const routine = row.routine;
    this.repository.activeBot(routine.botId);
    if (routine.state !== "active" || routine.schedule.kind !== "webhook")
      throw new AppError("unavailable", "Webhook 已暂停或撤销。");
    return routine;
  }
  webhook(
    id: string,
    token: string,
    input: WebhookInput,
    now: number,
    enqueue: Enqueue,
  ) {
    const routine = this.authenticate(id, token);
    if (Math.abs(now - input.timestamp) > 300000)
      throw new AppError(
        "unauthorized",
        "Webhook 时间戳已过期或超前，请校准时间。",
      );
    return this.fire(
      routine,
      {
        source: "webhook",
        key: `webhook:${input.eventId}`,
        payload: input.text,
        scheduledAt: null,
        now,
      },
      enqueue,
    );
  }
}
