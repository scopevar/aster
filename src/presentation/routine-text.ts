import type { RoutineReceipt } from "../shared/routines.js";
export function routineReceiptText(receipt: RoutineReceipt) {
  const enabled = receipt.routine.state === "active";
  const verb = {
    create: enabled ? "已创建并启用任务" : "已创建暂停任务",
    update: enabled ? "已更新并启用任务" : "已更新并暂停任务",
    pause: "已暂停任务",
    delete: "已删除任务",
  }[receipt.action];
  return `${verb}：${receipt.routine.name}`;
}
