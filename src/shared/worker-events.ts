import { z } from "zod";

/**
 * 变化提示的载荷契约。只携带元数据：epoch 区分数据库实例，revision 单调递增。
 * [Security]: 事件体不得包含消息内容、附件或任何用户数据；界面收到提示后另行按需拉取。
 */
export const storeCursorSchema = z
  .object({ epoch: z.uuid(), revision: z.number().int().nonnegative() })
  .strict();
export type StoreCursor = z.infer<typeof storeCursorSchema>;

/** 主进程转发给界面的后台状态：live 表示推送通道可用，offline 时界面退化为低频轮询。 */
export const workerSignalSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("live"), cursor: storeCursorSchema }).strict(),
  z.object({ state: z.literal("offline") }).strict(),
]);
export type WorkerSignal = z.infer<typeof workerSignalSchema>;

/**
 * [Invariant]: worker 每 keepaliveMs 至少写一次（数据或注释行）；主进程超过 staleAfterMs 未收到任何字节即判定连接僵死并重连。
 * 回环连接不会被中间设备静默丢弃，但 worker 事件循环卡死时 TCP 仍然“活着”，只能靠这条心跳发现。
 */
export const workerEventTiming = {
  keepaliveMs: 15000,
  staleAfterMs: 45000,
};

export function sameCursor(a: StoreCursor, b: StoreCursor) {
  return a.epoch === b.epoch && a.revision === b.revision;
}
