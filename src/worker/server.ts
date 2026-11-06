import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentConnections } from "../agent/connections.js";
import { LiveAgent } from "../agent/live.js";
import type { Agent } from "../chat/agent.js";
import type { SecretBox } from "../security/secret.js";
import { ownDirectory } from "../platform/directory-lease.js";
import { portForDirectory, type Endpoint } from "../platform/endpoint.js";
import { publishEndpoint } from "../platform/publish-endpoint.js";
import { AppError } from "../shared/core.js";
import { type Envelope } from "../shared/commands.js";
import { type Snapshot } from "../shared/snapshot.js";
import { localWorkspaceRequestSchema } from "../shared/local-workspace.js";
import { updatePreparationRequestSchema } from "../shared/update-preparation.js";
import { workerRoutes } from "../shared/protocol.js";
import { applyPendingRestore } from "../storage/backup/backup.js";
import { agentConnectionRoutes } from "./agent-connection-routes.js";
import { controlRoutes } from "./control-routes.js";
import {
  closeDataSession,
  openDataSession,
  wakeDataSession,
  type DataSession,
} from "./data-session.js";
import type { AsyncCommandKind } from "./dispatch.js";
import {
  bareRoute,
  controlJsonRoute,
  openEventStream,
  reply,
  uniqueRoutes,
  type WakeTopic,
  type WorkerRoute,
} from "./http-routes.js";
import { LocalWorkspace } from "./local-workspace.js";
import { pluginRoutes } from "./plugin-routes.js";
import { queryRoutes } from "./query-routes.js";
import { createWorkerHttpServer } from "./request-server.js";
import { resourceRoutes } from "./resource-routes.js";
import { sandboxRoutes } from "./sandbox-routes.js";
import { createScopedIngress } from "./scoped-ingress.js";
import { SessionRequests } from "./session-requests.js";

export async function startWorker(
  directory: string,
  options: {
    agent?: Agent;
    port?: number;
    supervisionId?: string;
    secretBox?: SecretBox;
    onStopped?: () => void;
    daemon?: { instanceId: string };
  } = {},
) {
  await mkdir(directory, { recursive: true });
  const agentHome = join(directory, "agent");
  await mkdir(agentHome, { recursive: true });
  const token = randomBytes(32).toString("hex");
  let closing = false;
  let stopped: Promise<void> | undefined;
  let dataSession: DataSession | undefined;
  let mounting: Promise<void> | undefined;
  const controlRequests = new SessionRequests();
  const workspace = new LocalWorkspace(directory);
  const owned = new LiveAgent(agentHome);
  const agent = options.agent ?? owned;
  let capability: Snapshot["capabilities"] = {
    agent: "unchecked",
    detail: "尚未检查模型连接。",
    accountType: null,
  };
  let check: Promise<void> | undefined;
  let checkController: AbortController | undefined;
  const connections = new AgentConnections(agentHome, () => {
    checkController?.abort();
    capability = {
      agent: "unchecked",
      detail: "供应商配置已更新，Bot 下一回合使用新配置。",
      accountType: null,
    };
    dataSession?.store.invalidateView();
  });
  const eventStreams = new Set<() => void>();
  const notify = (topic: WakeTopic) => {
    if (topic === "command") {
      dataSession?.tools.wake();
      dataSession?.deletions.wake();
    } else dataSession?.runtime.wake();
  };
  const { handleWebhook, handleTools } = createScopedIngress({
    get closing() {
      return closing;
    },
    get store() {
      return dataSession?.store;
    },
    get runtime() {
      return dataSession?.runtime;
    },
    get updatePreparing() {
      return dataSession?.updatePreparation.active ?? false;
    },
    get tools() {
      return dataSession?.tools;
    },
    notify,
  });
  const checkAgent = () => {
    if (!check) checkController = new AbortController();
    const signal = checkController?.signal;
    check ??= agent
      .check(signal)
      .then(
        (value) => {
          if (!signal?.aborted) capability = { agent: "ready", ...value };
        },
        (error: unknown) => {
          if (!signal?.aborted)
            capability = {
              agent: "unavailable",
              detail: error instanceof Error ? error.message : "模型不可用。",
              accountType: null,
            };
        },
      )
      .finally(() => {
        dataSession?.store.invalidateView();
        check = undefined;
        checkController = undefined;
      });
    return check;
  };
  const asyncRegistry = {
    avatar: {
      abortOnClose: false,
      run: (envelope: Envelope) => {
        if (!dataSession)
          throw new AppError("unavailable", "本地工作区尚未就绪。");
        return dataSession.avatars.save(envelope);
      },
    },
  } satisfies Record<
    AsyncCommandKind,
    {
      abortOnClose: boolean;
      run(envelope: Envelope, signal?: AbortSignal): Promise<unknown>;
    }
  >;
  const routes: readonly WorkerRoute[] = [
    controlJsonRoute(
      workerRoutes.localWorkspace,
      localWorkspaceRequestSchema,
      4096,
      async (input, ctx) => {
        if (input.action === "select") {
          if (mounting || dataSession)
            throw new AppError("conflict", "本地工作区已选择或正在准备。");
          const operation = (async () => {
            if (!(await workspace.status()).ready)
              await workspace.select(input.source);
            await mount();
          })();
          mounting = operation;
          try {
            await operation;
          } finally {
            mounting = undefined;
          }
        }
        reply(ctx.response, 200, {
          ...(await workspace.status()),
          ready: dataSession !== undefined,
        });
      },
    ),
    ...agentConnectionRoutes(connections),
    ...sandboxRoutes({
      get sandbox() {
        return dataSession?.sandbox;
      },
    }),
    ...pluginRoutes({
      get plugins() {
        return dataSession?.plugins;
      },
    }),
    ...queryRoutes({
      get server() {
        return server;
      },
      get capability() {
        return capability;
      },
      get scheduler() {
        return dataSession?.scheduler;
      },
    }),
    ...resourceRoutes({
      get accountDir() {
        return dataSession?.directory;
      },
      get closing() {
        return closing;
      },
      get pdf() {
        return dataSession?.pdf;
      },
    }),
    {
      scope: "control",
      method: "GET",
      path: workerRoutes.health,
      match: "exact",
      bodyLimit: undefined,
      enabled: undefined,
      run: async (ctx) => {
        reply(ctx.response, 200, { pid: process.pid });
      },
    },
    bareRoute("GET", workerRoutes.events, async (ctx) => {
      const end = openEventStream(ctx.response, ctx.store);
      eventStreams.add(end);
      ctx.response.once("close", () => eventStreams.delete(end));
    }),
    controlJsonRoute(
      workerRoutes.updatePreparation,
      updatePreparationRequestSchema,
      1024,
      async (input, ctx) => {
        if (!dataSession)
          throw new AppError("unavailable", "本地工作区尚未就绪。");
        const state = dataSession.updatePreparation.request(
          input.action,
          input.id,
        );
        if (input.action !== "stop") {
          reply(ctx.response, 200, state);
          return;
        }
        if (!state.ready)
          throw new AppError("conflict", "后台仍有未完成工作，未停止。");
        // Admission stays paused through this synchronous check and drain entry.
        reply(ctx.response, 200, {});
        void stop().catch(() =>
          console.error("update shutdown cleanup failed"),
        );
      },
    ),
    ...controlRoutes({
      get updatePreparation() {
        return dataSession?.updatePreparation;
      },
      checkAgent,
      options,
      directory,
      stop,
      asyncRegistry,
      notify,
      get commands() {
        return dataSession?.commands;
      },
    }),
  ];
  uniqueRoutes(routes);
  const server = createWorkerHttpServer({
    token,
    handleWebhook,
    handleTools,
    routes,
    controlRequests,
    get closing() {
      return closing;
    },
    get changingAccount() {
      return false;
    },
    get store() {
      return dataSession?.store;
    },
    get runtime() {
      return dataSession?.runtime;
    },
    get dataSession() {
      return dataSession;
    },
  });
  const ownership = await ownDirectory(directory, "worker");
  async function mount() {
    if (closing) return;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("TCP endpoint missing");
    await applyPendingRestore(workspace.directory);
    dataSession = await openDataSession(workspace.directory, {
      agent,
      connections,
      structuredModel: owned,
      port: address.port,
      ...(options.secretBox ? { secretBox: options.secretBox } : {}),
    });
    wakeDataSession(dataSession);
  }
  async function detach() {
    for (const end of eventStreams) end();
    eventStreams.clear();
    if (dataSession) {
      const previous = dataSession;
      dataSession = undefined;
      await closeDataSession(previous);
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const listening = () => {
        server.removeListener("error", failed);
        resolve();
      };
      const failed = (error: Error) => {
        server.removeListener("listening", listening);
        reject(error);
      };
      server.once("error", failed);
      server.once("listening", listening);
      server.listen(options.port ?? portForDirectory(directory), "127.0.0.1");
    });
    if ((await workspace.prepare()).ready) await mount();
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("TCP endpoint missing");
    const endpoint: Endpoint = {
      port: address.port,
      token,
      pid: process.pid,
      ...(options.daemon
        ? {
            kind: "daemon" as const,
            instanceId: options.daemon.instanceId,
            role: "execution" as const,
          }
        : {}),
      ...(options.supervisionId
        ? { supervisionId: options.supervisionId }
        : {}),
    };
    await publishEndpoint(directory, endpoint);
    return { endpoint, stop };
  } catch (error) {
    await detach();
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await ownership.close();
    throw error;
  }
  function stop() {
    return (stopped ??= drain());
  }
  async function drain() {
    closing = true;
    checkController?.abort();
    await controlRequests.close();
    await mounting;
    await detach();
    await check;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (options.daemon)
      await writeFile(
        join(directory, "daemon-stopped.json"),
        JSON.stringify({
          instanceId: options.daemon.instanceId,
          cleaned: true,
        }),
        { mode: 0o600 },
      );
    await ownership.close();
    options.onStopped?.();
  }
}
