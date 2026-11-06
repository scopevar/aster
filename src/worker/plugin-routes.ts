import type { PluginService } from "../plugins/service.js";
import { AppError } from "../shared/core.js";
import { pluginWorkerRequestSchema } from "../shared/tools/plugins.js";
import { workerRoutes } from "../shared/protocol.js";
import { jsonRoute, reply } from "./http-routes.js";
export function pluginRoutes(ctx: {
  readonly plugins: PluginService | undefined;
}) {
  return [
    jsonRoute(
      workerRoutes.plugins,
      pluginWorkerRequestSchema,
      512 * 1024,
      async (input, request) => {
        if (!ctx.plugins || ctx.plugins.store !== request.store)
          throw new AppError("unavailable", "插件服务不可用。");
        reply(
          request.response,
          200,
          await ctx.plugins.request(input, request.signal),
        );
      },
    ),
  ];
}
