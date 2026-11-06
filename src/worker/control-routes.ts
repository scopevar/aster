import { workerRoutes } from "../shared/protocol.js";
import { AppError } from "../shared/core.js";
import { envelopeSchema, type Envelope } from "../shared/commands.js";
import type { WorkspaceCommands } from "./commands.js";
import { asyncCommandKind, type AsyncCommandKind } from "./dispatch.js";
import type { WakeTopic, WorkerRoute } from "./http-routes.js";
import { controlJsonRoute, reply, replyAfterAbort } from "./http-routes.js";
import { requestSupervisedStop } from "./supervision.js";
export function controlRoutes(owner: {
  checkAgent(): Promise<void>;
  options: { supervisionId?: string };
  directory: string;
  stop(): Promise<void>;
  asyncRegistry: Record<
    AsyncCommandKind,
    {
      abortOnClose: boolean;
      run(envelope: Envelope, signal?: AbortSignal): Promise<unknown>;
    }
  >;
  notify(topic: WakeTopic): void;
  readonly commands: WorkspaceCommands | undefined;
}): readonly WorkerRoute[] {
  return [
    controlJsonRoute(
      workerRoutes.command,
      envelopeSchema,
      2 * 1024 * 1024 + 4096,
      async (envelope, ctx) => {
        if (envelope.command.type === "agent.check") {
          await owner.checkAgent();
          reply(ctx.response, 200, {});
          return;
        }
        if (envelope.command.type === "worker.stop") {
          if (owner.options.supervisionId)
            await requestSupervisedStop(
              owner.directory,
              owner.options.supervisionId,
            );
          reply(ctx.response, 200, {});
          void owner
            .stop()
            .catch((error: unknown) =>
              console.error(
                "worker stop failed",
                error instanceof Error ? error.name : "Error",
              ),
            );
          return;
        }
        const kind = asyncCommandKind(envelope.command);
        const commands = owner.commands;
        if (!commands)
          throw new AppError("unavailable", "本地工作区尚未就绪。");
        if (kind) {
          const registered = owner.asyncRegistry[kind];
          if (registered.abortOnClose)
            await replyAfterAbort(ctx.response, ctx.signal, (signal) =>
              registered.run(envelope, signal),
            );
          else reply(ctx.response, 200, await registered.run(envelope));
        } else reply(ctx.response, 200, commands.execute(envelope));
        owner.notify("command");
      },
    ),
  ];
}
