import { WorkspaceCommands } from "./commands.js";
import { AvatarCommands } from "../avatars/service.js";
import type { AgentConnections } from "../agent/connections.js";
import { PluginService } from "../plugins/service.js";
import { PluginOAuth } from "../plugins/oauth.js";
import { OAuthCredentialStore } from "../plugins/oauth-credentials.js";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../chat/agent.js";
import { Runtime } from "../chat/runtime.js";
import { HostJudge } from "../chat/group-judge.js";
import { DeletionService } from "../deletion/service.js";
import { DocumentReader } from "../documents/reader.js";
import { MemoryService } from "../memory/service.js";
import type { StructuredModel } from "../shared/memory.js";
import { RoutineScheduler } from "../routines/scheduler.js";
import { defaultSecretBox, type SecretBox } from "../security/secret.js";
import { Store } from "../storage/store.js";
import { ToolService } from "../tools/service.js";
import { SessionRequests } from "./session-requests.js";
import { SandboxService } from "../sandbox/service.js";

export type DataSession = Awaited<ReturnType<typeof openDataSession>>;

/** One local database and its execution services; no cloud identity or transport. */
export async function openDataSession(
  directory: string,
  deps: {
    agent: Agent;
    structuredModel: StructuredModel;
    port: number;
    secretBox?: SecretBox;
    connections?: AgentConnections;
  },
) {
  const workspace = join(directory, "workspaces");
  await mkdir(workspace, { recursive: true });
  let store: Store | undefined;
  let plugins: PluginService | undefined;
  let oauth: PluginOAuth | undefined;
  let memory: MemoryService | undefined;
  let pdf: DocumentReader | undefined;
  let sandbox: SandboxService | undefined;
  let runtime: Runtime | undefined;
  let scheduler: RoutineScheduler | undefined;
  let deletions: DeletionService | undefined;
  try {
    store = new Store(join(directory, "aster.sqlite"));
    store.recover();
    const secretBox = existsSync(join(directory, "os-crypt.key"))
      ? defaultSecretBox(directory)
      : (deps.secretBox ?? defaultSecretBox(directory));
    oauth = new PluginOAuth(
      store,
      new OAuthCredentialStore(join(directory, "plugin-auth"), secretBox),
    );
    plugins = new PluginService(store, oauth);
    memory = new MemoryService(store, deps.structuredModel);
    pdf = new DocumentReader(
      new URL("../../dist/documents/office-worker.js", import.meta.url),
    );
    sandbox = new SandboxService(store, directory, deps.connections);
    const tools = new ToolService(store, deps.port, pdf, oauth, sandbox);
    runtime = new Runtime(
      store,
      deps.agent,
      workspace,
      () => memory?.wake(),
      tools,
      undefined,
      async (hostBotId) => {
        const host =
          deps.structuredModel.capture?.(hostBotId) ?? deps.structuredModel;
        return deps.connections
          ? deps.connections.groupJudge(host)
          : new HostJudge(host);
      },
    );
    scheduler = new RoutineScheduler(store, runtime);
    deletions = new DeletionService(
      store,
      runtime,
      memory,
      workspace,
      deps.agent.cleanThreads?.bind(deps.agent),
      oauth.removeBot.bind(oauth),
    );
    return {
      directory,
      workspace,
      store,
      avatars: new AvatarCommands(store),
      commands: new WorkspaceCommands(store, runtime, () => memory?.wake()),
      plugins,
      memory,
      pdf,
      tools,
      sandbox,
      runtime,
      scheduler,
      deletions,
      requests: new SessionRequests(),
    };
  } catch (error) {
    await oauth?.close();
    scheduler?.stop();
    await deletions?.stop();
    await Promise.all([runtime?.stop(), memory?.stop()]);
    await sandbox?.stop();
    await pdf?.close();
    plugins?.close();
    store?.close();
    throw error;
  }
}
export function wakeDataSession(session: DataSession) {
  session.sandbox.start();
  session.runtime.wake();
  session.memory.wake();
  session.deletions.wake();
  session.scheduler.start();
}
export async function closeDataSession(session: DataSession) {
  const requests = session.requests.close();
  const avatars = session.avatars.stop();
  session.commands.stop();
  await session.plugins.oauth?.close();
  session.scheduler.stop();
  await session.deletions.stop();
  await Promise.all([session.runtime.stop(), session.memory.stop()]);
  await session.pdf.close();
  await session.sandbox.stop();
  await requests;
  await avatars;
  session.plugins.close();
  session.store.close();
}
