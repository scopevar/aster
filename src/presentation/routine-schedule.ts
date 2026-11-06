import type { RoutineSchedule } from "../shared/routines.js";

export function routineScheduleText(schedule: RoutineSchedule) {
  if (schedule.kind === "cron")
    return `${schedule.expression} · ${schedule.timeZone}`;
  if (schedule.kind === "webhook") return "Webhook";
  if (schedule.kind === "delay") return `延迟 ${schedule.seconds} 秒`;
  return `一次性 · ${new Date(schedule.at).toLocaleString("zh-CN")}`;
}
