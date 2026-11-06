import { dialog, shell } from "electron";
import { AppError } from "../../shared/core.js";
import { snapshotUpdateSchema } from "../../shared/snapshot.js";
import {
  pluginsRequestSchema,
  pluginsResponseSchema,
} from "../../shared/tools/plugins.js";
import { workerRoutes } from "../../shared/protocol.js";
import type { DesktopHandlerContext } from "./handler-context.js";
import { parseInput } from "./ipc-result.js";
export function registerPluginHandlers(
  ctx: Pick<
    DesktopHandlerContext,
    "handle" | "window" | "draining" | "workerCall"
  >,
) {
  ctx.handle("plugins", async (input) => {
    const request = parseInput(pluginsRequestSchema, input);
    if (ctx.draining) throw new AppError("unavailable", "界面正在退出。");
    if (request.action !== "prepare") {
      const result = pluginsResponseSchema.parse(
        await ctx.workerCall(workerRoutes.plugins, request),
      );
      if (request.action === "authorize" && result.authorizationUrl) {
        const url = new URL(result.authorizationUrl);
        if (
          url.username ||
          url.password ||
          url.hash ||
          (url.protocol !== "https:" &&
            !(
              url.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
            ))
        )
          throw new AppError("unauthorized", "MCP 授权地址无效。");
        if (ctx.draining)
          throw new AppError("unavailable", "界面正在退出，授权未打开。");
        try {
          await shell.openExternal(url.href);
        } catch {
          await ctx.workerCall(workerRoutes.plugins, {
            action: "disconnect",
            botId: request.botId,
            id: request.id,
            server: request.server,
          });
          throw new AppError("unavailable", "无法打开授权浏览器，请重试。");
        }
      }
      delete result.authorizationUrl;
      return result;
    }
    const owner = ctx.window;
    if (!owner || owner.isDestroyed())
      throw new AppError("unavailable", "窗口不可用。");
    const update = snapshotUpdateSchema.parse(
      await ctx.workerCall(workerRoutes.snapshot, {}),
    );
    if (
      !update.changed ||
      !update.snapshot.bots.some(
        (bot) => bot.id === request.botId && bot.lifecycle === "active",
      )
    )
      throw new AppError("not_found", "Bot 不存在。");
    const result = await dialog.showOpenDialog(owner, {
      title: "选择 Cursor 或 Claude Code 插件目录",
      properties: ["openDirectory"],
    });
    if (ctx.draining || ctx.window !== owner || owner.isDestroyed())
      throw new AppError("unavailable", "窗口已关闭，导入已取消。");
    if (result.canceled || !result.filePaths[0])
      return pluginsResponseSchema.parse(
        await ctx.workerCall(workerRoutes.plugins, {
          action: "list",
          botId: request.botId,
        }),
      );
    return pluginsResponseSchema.parse(
      await ctx.workerCall(workerRoutes.plugins, {
        ...request,
        root: result.filePaths[0],
        epoch: update.snapshot.epoch,
      }),
    );
  });
}
