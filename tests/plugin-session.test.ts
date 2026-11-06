import { messageActivity } from "../src/ui/features/messages/message-activity.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { z } from "zod";
import { Store } from "../src/storage/store.js";
import { PluginSession } from "../src/plugins/session.js";
import { connectPlugin } from "../src/plugins/connection.js";
import {
  pluginContentSchema,
  type PluginCall,
} from "../src/shared/tools/plugins.js";
import type { Command } from "../src/shared/commands.js";
const empty = {
  name: "fixture",
  description: "fixture",
  version: "1",
  format: "cursor",
  skills: [],
  servers: {},
  variables: [],
  warnings: [],
  files: {},
};
const execute = (store: Store, command: Command) =>
  store.execute({ id: randomUUID(), command });
function setup() {
  const store = new Store(":memory:");
  const created = execute(store, {
    type: "bot.create",
    name: "A",
    description: "",
  });
  assert.ok(created.id && created.conversationId);
  execute(store, {
    type: "message.send",
    conversationId: created.conversationId,
    text: "测试插件",
  });
  const job = store.runs.claim();
  assert.ok(job);
  return { store, job };
}
async function waitFor<T>(read: () => T | undefined) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw Error("fixture condition did not settle");
}
function card(store: Store, conversationId: string, tool: string) {
  return store.views
    .snapshot({ conversationId })
    .messages.map((message) => message.pluginCall)
    .find(
      (call): call is PluginCall =>
        !!call && call.tool === tool && call.status === "pending",
    );
}
await test("real stdio MCP waits for approval, preserves receipts, denies repeat effects and cleans owned resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-plugin-session-"));
  const { store, job } = setup();
  const runtime = new AbortController();
  const session = new PluginSession(store, job, runtime.signal);
  const effect = join(directory, "effects.jsonl"),
    pluginId = randomUUID();
  const priorSecret = process.env.ASTER_TOOL_TOKEN;
  process.env.ASTER_TOOL_TOKEN = "secret-never-inherit";
  let root: string | undefined;
  try {
    const fixture = await readFile(
      new URL("./fixtures/plugin-mcp.mjs", import.meta.url),
    );
    const content = pluginContentSchema.parse({
      ...empty,
      servers: {
        local: {
          command: process.execPath,
          args: ["${CURSOR_PLUGIN_ROOT}/server.mjs"],
          env: { EFFECT_PATH: "${EFFECT_PATH}" },
        },
      },
      variables: ["EFFECT_PATH"],
      files: { "server.mjs": fixture.toString("base64") },
    });
    store.plugins.install(
      job.botId,
      pluginId,
      content,
      { EFFECT_PATH: effect },
      true,
    );
    const signal = new AbortController().signal;
    const catalog = z
      .object({
        tools: z.array(z.object({ name: z.string() })),
        errors: z.array(z.unknown()),
      })
      .parse(
        await session.request(
          { callId: "list", operation: { action: "list" } },
          signal,
        ),
      );
    assert.deepEqual(catalog.errors, []);
    assert.equal(catalog.tools[0]?.name, "echo");
    const input = {
      callId: "approved",
      operation: {
        action: "call",
        pluginId,
        server: "local",
        tool: "echo",
        arguments: { text: "hello" },
      },
    };
    const pending = session.request(input, signal);
    const approval = await waitFor(() =>
      card(store, job.conversationId, "echo"),
    );
    const activityView = store.views.snapshot({
      conversationId: job.conversationId,
    });
    assert.equal(
      messageActivity(activityView.messages, activityView.runs)?.loading,
      true,
    );
    await assert.rejects(access(effect));
    const other = execute(store, {
      type: "bot.create",
      name: "B",
      description: "",
    });
    assert.ok(other.id);
    assert.throws(
      () => store.pluginCalls.decide(other.id!, approval.id, true),
      /不属于/,
    );
    store.pluginCalls.decide(job.botId, approval.id, true);
    const result = z
      .object({
        content: z.array(
          z.object({ type: z.literal("text"), text: z.string() }),
        ),
      })
      .parse(await pending);
    const echoed = z
      .object({
        inheritedSecret: z.null(),
        text: z.string(),
        pluginRoot: z.string(),
      })
      .parse(JSON.parse(result.content[0]!.text));
    assert.equal(echoed.text, "hello");
    root = echoed.pluginRoot;
    assert.equal(store.pluginCalls.get(approval.id).status, "completed");
    assert.match(
      store.runs.quote(
        job.conversationId,
        store.views
          .snapshot({ conversationId: job.conversationId })
          .messages.find((message) => message.pluginCall?.id === approval.id)!
          .id,
      ).text,
      /状态：completed/,
    );
    assert.deepEqual(await session.request(input, signal), result);
    assert.equal((await readFile(effect, "utf8")).trim().split("\n").length, 1);
    await assert.rejects(
      session.request(
        {
          ...input,
          operation: { ...input.operation, arguments: { text: "changed" } },
        },
        signal,
      ),
      /更换内容/,
    );
    const denied = session.request({ ...input, callId: "declined" }, signal);
    const decline = await waitFor(() =>
      card(store, job.conversationId, "echo"),
    );
    store.pluginCalls.decide(job.botId, decline.id, false);
    assert.equal(
      z.object({ status: z.string() }).parse(await denied).status,
      "declined",
    );
    assert.equal((await readFile(effect, "utf8")).trim().split("\n").length, 1);
    const revoked = session.request({ ...input, callId: "removed" }, signal);
    await waitFor(() => card(store, job.conversationId, "echo"));
    store.plugins.remove(job.botId, pluginId);
    assert.equal(
      z.object({ status: z.string() }).parse(await revoked).status,
      "cancelled",
    );
    await assert.rejects(
      session.request(
        { callId: "late", operation: { action: "list" } },
        signal,
      ),
    );
  } finally {
    runtime.abort();
    await session.close();
    store.close();
    if (priorSecret === undefined) delete process.env.ASTER_TOOL_TOKEN;
    else process.env.ASTER_TOOL_TOKEN = priorSecret;
    if (root) await assert.rejects(access(root));
    await rm(directory, { recursive: true, force: true });
  }
});
await test("cancelling a started MCP side effect is recorded unknown and never replayed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-plugin-cancel-"));
  const { store, job } = setup(),
    runtime = new AbortController();
  const session = new PluginSession(store, job, runtime.signal),
    pluginId = randomUUID(),
    effect = join(directory, "effects");
  try {
    const fixture = await readFile(
      new URL("./fixtures/plugin-mcp.mjs", import.meta.url),
    );
    const content = pluginContentSchema.parse({
      ...empty,
      servers: {
        local: {
          command: process.execPath,
          args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"],
          env: { EFFECT_PATH: effect },
        },
      },
      files: { "server.mjs": fixture.toString("base64") },
    });
    store.plugins.install(job.botId, pluginId, content, {}, true);
    await session.request(
      { callId: "list", operation: { action: "list" } },
      runtime.signal,
    );
    const input = {
      callId: "slow",
      operation: {
        action: "call",
        pluginId,
        server: "local",
        tool: "echo",
        arguments: { slow: true },
      },
    };
    const controller = new AbortController();
    const pending = session.request(input, controller.signal);
    const approval = await waitFor(() =>
      card(store, job.conversationId, "echo"),
    );
    store.pluginCalls.decide(job.botId, approval.id, true);
    await waitFor(() =>
      store.pluginCalls.get(approval.id).status === "running"
        ? true
        : undefined,
    );
    await waitFor(() => {
      try {
        return store.pluginCalls.get(approval.id).status === "running"
          ? true
          : undefined;
      } catch {
        return undefined;
      }
    });
    await delay(50);
    controller.abort();
    assert.equal(
      z.object({ status: z.string() }).parse(await pending).status,
      "unknown",
    );
    assert.equal(store.pluginCalls.get(approval.id).status, "unknown");
    assert.equal(
      z
        .object({ status: z.string() })
        .parse(await session.request(input, runtime.signal)).status,
      "unknown",
    );
    assert.equal((await readFile(effect, "utf8")).trim().split("\n").length, 1);
  } finally {
    runtime.abort();
    await session.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
await test("real streamable HTTP MCP forwards explicit authentication and executes only after approval", async () => {
  let performed = 0;
  const headers: string[] = [];
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    headers.push(request.headers.authorization ?? "");
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const message = z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(raw);
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown = {};
    if (message.method === "initialize")
      result = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "http-fixture", version: "1" },
      };
    if (message.method === "tools/list")
      result = { tools: [{ name: "remote", inputSchema: { type: "object" } }] };
    if (message.method === "tools/call") {
      performed++;
      result = { content: [{ type: "text", text: "remote result" }] };
    }
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { store, job } = setup();
  const runtime = new AbortController(),
    session = new PluginSession(store, job, runtime.signal);
  try {
    const pluginId = randomUUID();
    store.plugins.install(
      job.botId,
      pluginId,
      pluginContentSchema.parse({
        ...empty,
        servers: {
          remote: {
            url: `http://127.0.0.1:${address.port}/mcp`,
            headers: { Authorization: "Bearer ${TOKEN}" },
          },
        },
        variables: ["TOKEN"],
      }),
      { TOKEN: "fixture-token" },
      true,
    );
    await session.request(
      { callId: "list", operation: { action: "list" } },
      runtime.signal,
    );
    const pending = session.request(
      {
        callId: "remote",
        operation: {
          action: "call",
          pluginId,
          server: "remote",
          tool: "remote",
          arguments: {},
        },
      },
      runtime.signal,
    );
    const approval = await waitFor(() =>
      card(store, job.conversationId, "remote"),
    );
    assert.equal(performed, 0);
    store.pluginCalls.decide(job.botId, approval.id, true);
    assert.match(JSON.stringify(await pending), /remote result/);
    assert.equal(performed, 1);
    assert.ok(
      headers.length >= 4 &&
        headers.every((header) => header === "Bearer fixture-token"),
    );
  } finally {
    runtime.abort();
    await session.close();
    store.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
await test("connection failures never expose credentials and groups cannot discover private plugins", async () => {
  const controller = new AbortController();
  await assert.rejects(
    connectPlugin(
      pluginContentSchema.parse(empty),
      {
        command: "aster-missing-command",
        args: [],
        env: { SECRET: "hidden" },
      },
      {},
      controller.signal,
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("连接失败") &&
      !error.message.includes("hidden"),
  );
  const { store, job } = setup();
  const session = new PluginSession(
    store,
    { ...job, groupOrdinal: 0 },
    controller.signal,
  );
  try {
    await assert.rejects(
      session.request(
        { callId: "list", operation: { action: "list" } },
        controller.signal,
      ),
      /群聊/,
    );
  } finally {
    await session.close();
    store.close();
  }
});

await test("legacy SSE MCP uses the declared endpoint and closes the event stream", async () => {
  let events: ServerResponse | undefined;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET") {
      events = response;
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(202).end();
    if (message.id === undefined) return;
    let result: unknown = {};
    if (message.method === "initialize")
      result = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "sse-fixture", version: "1" },
      };
    if (message.method === "tools/list")
      result = { tools: [{ name: "legacy", inputSchema: { type: "object" } }] };
    if (message.method === "tools/call")
      result = { content: [{ type: "text", text: "SSE_OK" }] };
    events?.write(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
    );
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const controller = new AbortController();
  const connection = await connectPlugin(
    pluginContentSchema.parse(empty),
    { url: `http://127.0.0.1:${address.port}/sse`, type: "sse", headers: {} },
    {},
    controller.signal,
  );
  try {
    assert.equal(
      (await connection.client.listTools()).tools[0]?.name,
      "legacy",
    );
    assert.match(
      JSON.stringify(
        await connection.client.callTool({ name: "legacy", arguments: {} }),
      ),
      /SSE_OK/,
    );
  } finally {
    await connection.close();
    events?.end();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
