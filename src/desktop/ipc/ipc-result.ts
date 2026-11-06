import type { z } from "zod";
import { AppError, type Failure } from "../../shared/core.js";
import type { Result } from "../../shared/ipc-contracts.js";

/** 与 AppError 区分：这是 ipcMain 未能确认结果时对 Renderer 暴露的兜底说明。 */
export const unconfirmedFailure: Failure = {
  code: "unknown",
  message: "操作结果未能确认，请重试。",
};

function isAbort(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export function toFailure(error: unknown, fallback: Failure): Failure {
  if (error instanceof AppError)
    return { code: error.code, message: error.message };
  if (isAbort(error))
    return { code: "unavailable", message: "操作已取消或超时。" };
  // [Security]: 非领域错误可能带本机路径或内部栈信息，只写入主进程日志，不下发到 Renderer。
  console.error("Desktop IPC handler failed", error);
  return fallback;
}

/** 把 handler 的返回值或异常收敛成可结构化克隆的 Result，同步抛出也会被捕获。 */
export function settle<T>(
  task: () => T | Promise<T>,
  fallback: Failure = unconfirmedFailure,
): Promise<Result<T>> {
  return Promise.resolve()
    .then(task)
    .then(
      (data): Result<T> => ({ success: true, data }),
      (error: unknown): Result<T> => ({
        success: false,
        error: toFailure(error, fallback),
      }),
    );
}

/**
 * 只用于解析 Renderer 入参。响应解析失败不能归为 invalid_input：
 * 那意味着请求可能已被后台提交，UI 若据此丢弃重试凭据会造成重复或丢失。
 */
export function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  message = "请求参数不符合接口约定。",
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("invalid_input", message);
  return parsed.data;
}
