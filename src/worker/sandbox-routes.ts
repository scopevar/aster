import type { SandboxService } from "../sandbox/service.js";
import { AppError } from "../shared/core.js";
import { workerRoutes } from "../shared/protocol.js";
import { sandboxSettingsRequestSchema } from "../shared/tools/sandbox-settings.js";
import { jsonRoute, reply } from "./http-routes.js";

export function sandboxRoutes(ctx: {
  readonly sandbox: SandboxService | undefined;
}) {
  return [
    jsonRoute(
      workerRoutes.sandboxSettings,
      sandboxSettingsRequestSchema,
      16384,
      async (input, request) => {
        const sandbox = ctx.sandbox;
        if (!sandbox) throw new AppError("unavailable", "沙箱服务不可用。");
        reply(
          request.response,
          200,
          await sandbox.request(input, request.signal, true),
        );
      },
    ),
  ];
}
