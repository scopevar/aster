import { CronExpressionParser } from "cron-parser";
import { AppError } from "../shared/core.js";
import type { RoutineSchedule } from "../shared/routines.js";

/** A persisted schedule never keeps a relative delay; it is resolved when saved. */
export type StoredRoutineSchedule = Exclude<RoutineSchedule, { kind: "delay" }>;

/** Resolve a relative delay against the transaction's clock before it is stored. */
export function resolveRoutineSchedule(
  schedule: RoutineSchedule,
  now: number,
): StoredRoutineSchedule {
  if (schedule.kind !== "delay") return schedule;
  return {
    kind: "at",
    at: new Date(now + schedule.seconds * 1000).toISOString(),
  };
}

/** A pure next-instant calculation; persisted cursors and execution belong to Store. */
export function nextRoutineTime(
  schedule: RoutineSchedule,
  after: number,
): number | null {
  if (schedule.kind === "webhook") return null;
  if (schedule.kind === "delay") return after + schedule.seconds * 1000;
  if (schedule.kind === "at") {
    const at = Date.parse(schedule.at);
    if (!Number.isSafeInteger(at) || at <= after)
      throw new AppError(
        "invalid_input",
        `一次性任务的时间必须晚于当前时间（at=${Number.isFinite(at) ? new Date(at).toISOString() : schedule.at}，now=${new Date(after).toISOString()}），请重新选择。`,
      );
    return at;
  }
  try {
    // Five fields bound the frequency to one minute; hashed/random schedules are not reproducible cursors.
    if (
      schedule.expression.split(/\s+/).length !== 5 ||
      /[Hh]/.test(schedule.expression)
    )
      throw new Error("five fields required");
    new Intl.DateTimeFormat("en", { timeZone: schedule.timeZone }).format(
      after,
    );
    const next = CronExpressionParser.parse(schedule.expression, {
      currentDate: after,
      tz: schedule.timeZone,
    })
      .next()
      .getTime();
    if (!Number.isSafeInteger(next) || next <= after)
      throw new Error("invalid next time");
    return next;
  } catch {
    throw new AppError(
      "invalid_input",
      "请输入有效的五段 cron 和 IANA 时区，例如 0 9 * * 1-5、Asia/Shanghai。",
    );
  }
}

/** When an enabled definition should fire next. An overdue one-time time still runs once. */
export function routineStartTime(
  schedule: RoutineSchedule,
  now: number,
): number | null {
  if (schedule.kind === "delay") return now + schedule.seconds * 1000;
  if (schedule.kind === "at") return Date.parse(schedule.at);
  return nextRoutineTime(schedule, now);
}

/** After a one-time definition has fired there is no next instant. */
export function routineFollowUpTime(
  schedule: RoutineSchedule,
  now: number,
): number | null {
  if (schedule.kind === "delay" || schedule.kind === "at") return null;
  return nextRoutineTime(schedule, now);
}
