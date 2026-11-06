import type { AppUpdateState } from "../../shared/desktop/app-update.js";
import { AppError } from "../../shared/core.js";

export const UPDATE_STOP_FAILED = "更新前未能停止后台，安装已取消。";

/**
 * AppImage 安装会立刻拉起新进程。旧进程仍持有单实例锁时，新进程会直接退出。
 * 因此先标记退出并释放锁，再交给安装器；安装失败则两者都恢复。
 */
export async function performUpdateInstall(input: {
  updates: {
    beginInstall(): void;
    cancelInstall(): void;
    finishInstall(): AppUpdateState;
  };
  stopWorker(): Promise<void>;
  restoreWorker?(): Promise<unknown>;
  held(): boolean;
  release(): void;
  request(): void;
  setQuitting(value: boolean): void;
}): Promise<AppUpdateState> {
  input.updates.beginInstall();
  try {
    await input.stopWorker();
  } catch (error) {
    input.updates.cancelInstall();
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new AppError(
      "unavailable",
      error instanceof AppError
        ? `${UPDATE_STOP_FAILED}${error.message}`.slice(0, 200)
        : UPDATE_STOP_FAILED,
    );
  }
  const held = input.held();
  input.setQuitting(true);
  if (held) input.release();
  const state = input.updates.finishInstall();
  if (state.status === "error") {
    input.setQuitting(false);
    if (held && !input.held()) input.request();
    try {
      await input.restoreWorker?.();
    } catch {
      throw new AppError(
        "unavailable",
        "安装未完成，后台未能恢复，请重新打开应用并核实任务状态。",
      );
    }
  }
  return state;
}
