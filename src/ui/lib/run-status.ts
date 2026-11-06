import type { Run } from "../../shared/chat/runs.js";
export const statusLabel: Record<Run["status"], string> = {
  queued: "排队中",
  running: "工作中",
  cancelling: "正在停止…",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  unknown: "结果未知",
};
