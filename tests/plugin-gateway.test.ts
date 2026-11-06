import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Agent } from "../src/chat/agent.js";
import { connectPlugin } from "../src/plugins/connection.js";
import { workerRoutes } from "../src/shared/protocol.js";
import {
  pluginContentSchema,
  pluginsResponseSchema,
} from "../src/shared/tools/plugins.js";
import { resultSchema } from "../src/shared/core.js";
import { type Command } from "../src/shared/commands.js";
import { startWorker } from "../src/worker/server.js";
import { workerSnapshot } from "./helpers/worker-snapshot.js";

await test(
  "real Worker and built MCP gateway discover the scoped tools and require approval before calling the imported plugin",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "aster-plugin-gateway-")),
      root = await mkdtemp(join(tmpdir(), "aster-plugin-package-")),
      effects = join(directory, "effects");
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "fixture",
        mcpServers: {
          local: {
            command: process.execPath,
            args: ["${CLAUDE_PLUGIN_ROOT}/fixture.mjs"],
            env: { EFFECT_PATH: "${EFFECT_PATH}" },
          },
        },
      }),
    );
    await writeFile(
      join(root, "fixture.mjs"),
      await readFile(new URL("./fixtures/plugin-mcp.mjs", import.meta.url)),
    );
    let completed: unknown;
    let tools: string[] = [];
    const agent: Agent = {
      check: async () => ({ accountType: null, detail: "fixture" }),
      async run(input) {
        assert.ok(input.toolAccess);
        const gateway = await connectPlugin(
          pluginContentSchema.parse({
            name: "gateway",
            description: "",
            version: "1",
            format: "generic",
            skills: [],
            servers: {},
            files: {},
            variables: [],
            warnings: [],
          }),
          {
            command: process.execPath,
            args: [resolve("dist/tools/mcp-server.js")],
            env: {
              ASTER_TOOL_PORT: String(input.toolAccess.port),
              ASTER_TOOL_TOKEN: input.toolAccess.token,
            },
          },
          {},
          input.signal,
        );
        try {
          tools = (await gateway.client.listTools()).tools
            .map((tool) => tool.name)
            .sort();
          const catalogResult = await gateway.client.callTool({
            name: "plugins",
            arguments: { operation: { action: "list" } },
          });
          const result = z
            .object({
              content: z.array(
                z.object({ type: z.literal("text"), text: z.string() }),
              ),
            })
            .parse(catalogResult);
          const catalog = z
            .object({
              tools: z.array(
                z.object({
                  pluginId: z.uuid(),
                  server: z.string(),
                  name: z.string(),
                }),
              ),
              errors: z.array(z.unknown()),
            })
            .parse(JSON.parse(result.content[0]!.text));
          assert.deepEqual(catalog.errors, []);
          const tool = catalog.tools[0];
          assert.ok(tool);
          completed = await gateway.client.callTool(
            {
              name: "plugins",
              arguments: {
                operation: {
                  action: "call",
                  pluginId: tool.pluginId,
                  server: tool.server,
                  tool: tool.name,
                  arguments: { text: "GATEWAY_OK" },
                },
              },
            },
            { signal: input.signal, timeout: 15000 },
          );
          input.onEvent({
            type: "text",
            itemId: "fixture-result",
            text: JSON.stringify(completed),
            complete: true,
          });
          return { status: "completed", error: null };
        } finally {
          await gateway.close();
        }
      },
    };
    const worker = await startWorker(directory, { agent, port: 0 });
    try {
      const base = `http://127.0.0.1:${worker.endpoint.port}`,
        headers = {
          Authorization: `Bearer ${worker.endpoint.token}`,
          "Content-Type": "application/json",
        };
      const request = async (route: string, body: unknown) => {
        const response = await fetch(`${base}${route}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const value: unknown = await response.json();
        assert.equal(response.status, 200, JSON.stringify(value));
        return value;
      };
      const command = async (command: Command) =>
        resultSchema.parse(
          await request(workerRoutes.command, { id: randomUUID(), command }),
        );
      const bot = await command({
        type: "bot.create",
        name: "Gateway",
        description: "",
      });
      assert.ok(bot.id && bot.conversationId);
      const snapshot = await workerSnapshot(worker.endpoint);
      const draft = pluginsResponseSchema.parse(
        await request(workerRoutes.plugins, {
          action: "prepare",
          botId: bot.id,
          root,
          epoch: snapshot.epoch,
        }),
      );
      assert.ok(draft.preview);
      await request(workerRoutes.plugins, {
        action: "install",
        botId: bot.id,
        id: draft.preview.id,
        epoch: draft.preview.epoch,
        variables: { EFFECT_PATH: effects },
        enableTools: true,
      });
      await command({
        type: "message.send",
        conversationId: bot.conversationId,
        text: "插件工具调用",
      });
      let callId: string | undefined;
      for (let attempt = 0; attempt < 500 && !callId; attempt++) {
        const view = await workerSnapshot(worker.endpoint, {
          conversationId: bot.conversationId,
        });
        const failed = view.runs.find((run) => run.status === "failed");
        if (failed) throw Error(failed.error ?? "run failed");
        callId = view.messages.find(
          (message) => message.pluginCall?.status === "pending",
        )?.pluginCall?.id;
        if (!callId) await delay(10);
      }
      assert.ok(
        callId,
        "The gateway must reach the actual persisted approval card",
      );
      await assert.rejects(access(effects));
      assert.deepEqual(tools, [
        "ask_user",
        "notify",
        "plugins",
        "read",
        "routines",
        "shell",
        "skills",
        "templates",
      ]);
      await request(workerRoutes.plugins, {
        action: "decide",
        botId: bot.id,
        id: callId,
        allow: true,
      });
      for (let attempt = 0; attempt < 500; attempt++) {
        const view = await workerSnapshot(worker.endpoint, {
          conversationId: bot.conversationId,
        });
        if (view.runs.some((run) => run.status === "completed")) break;
        if (attempt === 499) throw Error("Run did not finish");
        await delay(10);
      }
      assert.match(JSON.stringify(completed), /GATEWAY_OK/);
      assert.equal(
        (await readFile(effects, "utf8")).trim().split("\n").length,
        1,
      );
      const final = await workerSnapshot(worker.endpoint, {
        conversationId: bot.conversationId,
      });
      assert.equal(
        final.messages.find((message) => message.pluginCall?.id === callId)
          ?.pluginCall?.status,
        "completed",
      );
    } finally {
      await worker.stop();
      await rm(directory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);
