import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginsResponseSchema } from "../../src/shared/tools/plugins.js";
import { readWorker, callWorker } from "../../src/worker/client.js";
import { workerRoutes } from "../../src/shared/protocol.js";
import { snapshotUpdateSchema } from "../../src/shared/snapshot.js";

export async function installDaemonPlugin(
  directory: string,
  botId: string,
  root: string,
  effects: string,
) {
  await mkdir(join(root, ".cursor-plugin"), { recursive: true });
  await writeFile(
    join(root, ".cursor-plugin", "plugin.json"),
    JSON.stringify({
      name: "daemon-approval-fixture",
      description: "审批验收",
      mcpServers: {
        local: {
          command: process.execPath,
          args: ["${CURSOR_PLUGIN_ROOT}/server.mjs"],
          env: { EFFECT_PATH: "${EFFECT_PATH}" },
        },
      },
    }),
  );
  await writeFile(
    join(root, "server.mjs"),
    await readFile(new URL("../fixtures/plugin-mcp.mjs", import.meta.url)),
  );
  const endpoint = await readWorker(directory);
  const view = snapshotUpdateSchema.parse(
    await callWorker(endpoint, workerRoutes.snapshot, {}),
  );
  if (!view.changed) throw Error("Missing host snapshot");
  const prepared = pluginsResponseSchema.parse(
    await callWorker(endpoint, workerRoutes.plugins, {
      action: "prepare",
      botId,
      root,
      epoch: view.snapshot.epoch,
    }),
  );
  if (!prepared.preview) throw Error("Missing plugin preview");
  const installed = pluginsResponseSchema.parse(
    await callWorker(endpoint, workerRoutes.plugins, {
      action: "install",
      botId,
      id: prepared.preview.id,
      epoch: prepared.preview.epoch,
      variables: { EFFECT_PATH: effects },
      enableTools: true,
    }),
  );
  const plugin = installed.plugins[0];
  if (!plugin) throw Error("Plugin was not installed");
  return plugin.id;
}
