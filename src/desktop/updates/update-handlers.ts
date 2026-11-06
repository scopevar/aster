import { app } from "electron";
import {
  appUpdateRequestSchema,
  type AppUpdateState,
} from "../../shared/desktop/app-update.js";
import type { DesktopAppUpdater } from "./app-updater.js";
import type { DesktopHandlerContext } from "../ipc/handler-context.js";
import { parseInput } from "../ipc/ipc-result.js";
import { performUpdateInstall } from "./update-install.js";
import { prepareUpdateBackground } from "./update-background.js";
import { AppError } from "../../shared/core.js";

export function registerUpdateHandlers(
  ctx: Pick<DesktopHandlerContext, "handle" | "worker" | "quitting">,
  updates: DesktopAppUpdater,
  directory: string,
  startBackground: () => Promise<unknown>,
) {
  let controller: AbortController | undefined;
  let installing: Promise<AppUpdateState> | undefined;
  let cancellable = false;
  let backgroundStopped = false;
  let recovery: Promise<void> | undefined;
  // Installer errors can arrive after quitAndInstall returns to the old controller.
  const recover = () => {
    if (
      installing ||
      recovery ||
      !backgroundStopped ||
      updates.getState().status !== "error"
    )
      return;
    backgroundStopped = false;
    ctx.quitting = false;
    if (!app.hasSingleInstanceLock()) app.requestSingleInstanceLock();
    recovery = startBackground()
      .then(
        () => {
          updates.cancelInstall(
            "安装更新失败，后台已恢复运行。已下载的更新保留，可重试。",
          );
        },
        () => {
          updates.cancelInstall(
            "安装未完成，后台未能恢复，请重新打开应用并核实任务状态。",
          );
        },
      )
      .finally(() => {
        recovery = undefined;
      });
  };
  updates.subscribe(recover);
  app.on("before-quit", () => {
    if (cancellable) controller?.abort();
  });
  ctx.handle("appUpdate", async (input) => {
    const request = parseInput(appUpdateRequestSchema, input);
    if (request.action === "state") return updates.getState();
    if (request.action === "check") return updates.check();
    if (request.action === "download") return updates.download();
    if (request.action === "cancel-install") {
      if (!cancellable)
        throw new AppError("conflict", "后台已开始停止，请等待安装并重启。");
      controller?.abort();
      await installing;
      return updates.getState();
    }
    if (installing || recovery)
      throw new AppError("conflict", "已有更新操作正在进行。");
    if (
      updates.getState().status !== "downloaded" ||
      !updates.getState().downloadedVersion
    )
      throw new AppError("invalid_input", "更新尚未下载完成。");
    controller = new AbortController();
    const signal = controller.signal;
    cancellable = true;
    installing = performUpdateInstall({
      updates,
      stopWorker: async () => {
        await prepareUpdateBackground({
          directory,
          signal,
          waiting: (message) => updates.prepareInstall(message),
          installing: () => {
            cancellable = false;
            updates.prepareInstall("正在停止后台并安装更新，即将重启…", true);
          },
        });
        backgroundStopped = true;
      },
      restoreWorker: startBackground,
      held: () => app.hasSingleInstanceLock(),
      release: () => app.releaseSingleInstanceLock(),
      request: () => {
        app.requestSingleInstanceLock();
      },
      setQuitting: (value) => {
        ctx.quitting = value;
      },
    })
      .then((state) => {
        if (state.status === "error") {
          backgroundStopped = false;
          updates.cancelInstall(
            "安装更新失败，后台已恢复运行。已下载的更新保留，可重试。",
          );
        }
        return updates.getState();
      })
      .catch((error: unknown) => {
        backgroundStopped = false;
        const message =
          error instanceof Error && error.name === "AbortError"
            ? "更新已取消，后台恢复接收新任务。已下载的更新保留。"
            : error instanceof AppError
              ? error.message
              : "更新未完成，请核实后台状态后重试。";
        updates.cancelInstall(message);
        return updates.getState();
      })
      .finally(() => {
        controller = undefined;
        installing = undefined;
        cancellable = false;
        recover();
      });
    return updates.getState();
  });
}
