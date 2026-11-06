import { app } from "electron";
import { appUpdateRequestSchema } from "../../shared/desktop/app-update.js";
import type { DesktopAppUpdater } from "./app-updater.js";
import type { DesktopHandlerContext } from "../ipc/handler-context.js";
import { parseInput } from "../ipc/ipc-result.js";
import { performUpdateInstall } from "./update-install.js";

export function registerUpdateHandlers(
  ctx: Pick<DesktopHandlerContext, "handle" | "worker" | "quitting">,
  updates: DesktopAppUpdater,
  stopBackground: () => Promise<void>,
) {
  ctx.handle("appUpdate", async (input) => {
    const request = parseInput(appUpdateRequestSchema, input);
    if (request.action === "state") return updates.getState();
    if (request.action === "check") return updates.check();
    if (request.action === "download") return updates.download();
    return performUpdateInstall({
      updates,
      stopWorker: stopBackground,
      held: () => app.hasSingleInstanceLock(),
      release: () => app.releaseSingleInstanceLock(),
      request: () => {
        app.requestSingleInstanceLock();
      },
      setQuitting: (value) => {
        ctx.quitting = value;
      },
    });
  });
}
