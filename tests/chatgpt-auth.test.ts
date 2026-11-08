import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { Type } from "typebox";
import { AgentConnections } from "../src/agent/connections.js";
import { startWorker } from "../src/worker/server.js";
import { WorkerConnection } from "../src/desktop/worker/worker-connection.js";
import { requestChatGPTAuth } from "../src/desktop/ipc/chatgpt-auth.js";
import {
  chatGPTAuthReplySchema,
  chatGPTAuthRequestSchema,
  type ChatGPTAuthStatus,
} from "../src/shared/chatgpt-auth.js";
import { agentConnectionSchema } from "../src/shared/agent-connections.js";
import { PiCredentials } from "../src/agent/pi-credentials.js";
import { configuredModel } from "../src/agent/pi-model.js";

// Owner: real Worker HTTP + Pi OAuth + OS credential storage. Only OpenAI's
// external token/catalog endpoints are replaced; the loopback callback is real.
await test("ChatGPT login preserves credentials on cancellation, seals successful grants and survives worker restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aster-chatgpt-"));
  const credentials = new PiCredentials(join(directory, "agent"));
  const realFetch = globalThis.fetch;
  let tokenRequests = 0;
  let inferenceRequests = 0;
  let expectedModel = "account-model";
  let withTools = false;
  let catalogFails = false;
  let deny = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://auth.openai.com/api/accounts/oauth/token") {
        tokenRequests++;
        const fields = new URLSearchParams(String(init?.body));
        assert.equal(fields.get("client_id"), "oaiapp_fixture");
        assert.ok(fields.get("code_verifier"));
        return Response.json({
          access_token: "subscription-access-fixture",
          refresh_token: "refresh-fixture",
          expires_in: 3600,
          id_token: "identity-fixture",
          scope: deny ? "openid" : "openid chatgpt.tokens.use.direct",
        });
      }
      if (url === "https://api.openai.com/v1/models") {
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer subscription-access-fixture",
        );
        if (catalogFails) return new Response("Unavailable", { status: 503 });
        return Response.json({
          models: [
            {
              slug: "account-model",
              display_name: "Account Model",
              visibility: "list",
            },
            {
              slug: "hidden-model",
              display_name: "Hidden",
              visibility: "hide",
            },
          ],
        });
      }
      if (url === "https://api.openai.com/v1/responses") {
        inferenceRequests++;
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer subscription-access-fixture",
        );
        const payload: unknown = JSON.parse(String(init?.body));
        const request = z
          .object({
            model: z.string(),
            store: z.literal(false),
            stream: z.literal(true),
            input: z.array(z.unknown()),
          })
          .passthrough()
          .parse(payload);
        assert.equal(request.model, expectedModel);
        assert.ok(!("max_output_tokens" in request));
        assert.ok(!("temperature" in request));
        const declarations = request.input.map((item) =>
          z
            .object({
              type: z.literal("additional_tools"),
              tools: z.array(z.object({ name: z.string() })),
            })
            .safeParse(item),
        );
        const hasResult = request.input.some(
          (item) =>
            z
              .object({
                type: z.literal("function_call_output"),
                output: z.string(),
              })
              .safeParse(item).success,
        );
        if (withTools) {
          assert.ok(
            declarations.some(
              (item) =>
                item.success &&
                item.data.tools.some((tool) => tool.name === "read"),
            ),
            "subscription tools must be declared in additional_tools",
          );
          assert.ok(
            !("tools" in request),
            "subscription requests must not send flat top-level function tools",
          );
          if (!hasResult) {
            const call = {
              id: "fc_fixture",
              call_id: "call_fixture",
              type: "function_call",
              name: "read",
              arguments: "{}",
              status: "completed",
            };
            return new Response(
              [
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: call,
                },
                {
                  type: "response.completed",
                  response: {
                    id: "response-tool",
                    status: "completed",
                    output: [call],
                  },
                },
              ]
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join(""),
              { headers: { "Content-Type": "text/event-stream" } },
            );
          }
          assert.ok(
            JSON.stringify(request.input).includes("tool-result-fixture"),
          );
        }
        const item = {
          id: "message-fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "subscription response",
              annotations: [],
            },
          ],
        };
        return new Response(
          [
            { type: "response.created", response: { id: "response-fixture" } },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: "response-fixture",
                status: "completed",
                output: [item],
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return realFetch(input, init);
    },
  );
  let server = await startWorker(directory, { port: 0 });
  let worker = new WorkerConnection(directory);
  let authorization = new URL("https://example.invalid");
  const start = (id = randomUUID()) =>
    requestChatGPTAuth(worker, { action: "start", id }, async (url) => {
      authorization = new URL(url);
    });
  const status = async () =>
    chatGPTAuthReplySchema.parse(
      await worker.call("/chatgpt-auth", { action: "status" }),
    );
  const settled = async () => {
    const deadline = Date.now() + 15000;
    let value = await status();
    while (value.state === "pending" && Date.now() < deadline) {
      await setTimeout(25);
      value = await status();
    }
    assert.notEqual(
      value.state,
      "pending",
      "login must finish and release its callback listener",
    );
    return value;
  };
  const callback = async () => {
    const url = new URL(authorization.searchParams.get("redirect_uri")!);
    url.search = new URLSearchParams({
      state: authorization.searchParams.get("state")!,
      code: "fixture-code",
      client_id: "oaiapp_fixture",
    }).toString();
    assert.equal((await realFetch(url)).status, 200);
  };
  try {
    await credentials.modify("openai", async () => ({
      type: "api_key",
      key: "original-api-key",
    }));
    const first = await start();
    assert.equal(first.state, "pending");
    assert.equal(first.authenticated, false);
    assert.ok(
      !("authorizationUrl" in first),
      "Main never exposes the authorization URL to Renderer",
    );
    assert.equal(authorization.origin, "https://auth.openai.com");
    assert.equal(authorization.searchParams.get("agent_name_hint"), "Aster");
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    const hostId = authorization.searchParams.get("ext_agent_host_id");
    assert.match(hostId!, /^urn:uuid:/);
    await worker.call("/chatgpt-auth", { action: "cancel", id: first.id });
    assert.equal((await credentials.read("openai"))?.type, "api_key");
    assert.equal(tokenRequests, 0);
    deny = true;
    await start();
    assert.equal(authorization.searchParams.get("ext_agent_host_id"), hostId);
    await callback();
    assert.equal(
      (await settled()).state,
      "error",
      "missing subscription scope must fail",
    );
    assert.equal((await credentials.read("openai"))?.type, "api_key");
    deny = false;
    await start();
    await callback();
    const connected = await settled();
    assert.equal(connected.state, "connected");
    assert.equal(connected.authenticated, true);
    assert.deepEqual(connected.models, [
      { id: "account-model", name: "Account Model" },
    ]);
    assert.ok(
      !JSON.stringify(connected).includes("subscription-access-fixture"),
    );
    const bytes = await readFile(join(directory, "agent", "pi-auth.sealed"));
    assert.ok(!bytes.includes(Buffer.from("subscription-access-fixture")));
    const entry = agentConnectionSchema.parse({
      id: "subscription",
      provider: "openai",
      model: "account-model",
      auth: "chatgpt",
    });
    const configured = await configuredModel(
      join(directory, "agent"),
      entry,
      AbortSignal.timeout(10000),
    );
    try {
      assert.equal(configured.model.baseUrl, "https://api.openai.com/v1");
      assert.equal(
        (await configured.runtime.getAuth("openai"))?.auth.apiKey,
        "subscription-access-fixture",
      );
      const reply = await configured.runtime.complete(
        configured.model,
        {
          systemPrompt: "Reply briefly.",
          messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
        },
        {
          maxTokens: 100,
          temperature: 0.2,
          signal: AbortSignal.timeout(10000),
        },
      );
      assert.equal(reply.stopReason, "stop");
      assert.ok(
        reply.content.some(
          (part) =>
            part.type === "text" && part.text === "subscription response",
        ),
      );
      assert.equal(inferenceRequests, 1);
    } finally {
      await configured.release();
    }
    withTools = true;
    for (const model of ["gpt-5.4", "account-model"]) {
      expectedModel = model;
      const selected = await configuredModel(
        join(directory, "agent"),
        { ...entry, model },
        AbortSignal.timeout(10000),
      );
      try {
        const user = {
          role: "user" as const,
          content: "Read a resource",
          timestamp: Date.now(),
        };
        const tools = [
          {
            name: "read",
            description: "Read a fixture resource",
            parameters: Type.Object({}),
          },
        ];
        const reply = await selected.runtime.complete(
          selected.model,
          { systemPrompt: "Use the read tool.", messages: [user], tools },
          { signal: AbortSignal.timeout(10000) },
        );
        assert.equal(reply.stopReason, "toolUse", reply.errorMessage);
        const call = reply.content.find((part) => part.type === "toolCall");
        assert.ok(call?.type === "toolCall");
        const result = await selected.runtime.complete(
          selected.model,
          {
            systemPrompt: "Use the read tool.",
            tools,
            messages: [
              user,
              reply,
              {
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [{ type: "text", text: "tool-result-fixture" }],
                isError: false,
                timestamp: Date.now(),
              },
            ],
          },
          { signal: AbortSignal.timeout(10000) },
        );
        assert.equal(result.stopReason, "stop");
        assert.ok(
          result.content.some(
            (part) =>
              part.type === "text" && part.text === "subscription response",
          ),
        );
      } finally {
        await selected.release();
      }
    }
    assert.equal(inferenceRequests, 5);
    await assert.rejects(
      configuredModel(
        join(directory, "agent"),
        { ...entry, auth: "stored", baseUrl: "https://example.com/v1" },
        AbortSignal.timeout(10000),
      ),
      /官方 OpenAI/,
    );
    catalogFails = true;
    await start();
    await callback();
    const withoutCatalog = await settled();
    assert.equal(withoutCatalog.authenticated, true);
    assert.deepEqual(
      withoutCatalog.models,
      [],
      "a new grant must not retain the previous account's models",
    );
    assert.match(withoutCatalog.message, /模型列表暂不可用/);
    const settings = new AgentConnections(join(directory, "agent"));
    try {
      const before = settings.status();
      const stored = { ...entry, auth: "stored" as const };
      await settings.request(
        {
          action: "save",
          revision: before.revision,
          config: { defaultAgent: stored.id, connections: [stored] },
          credential: { provider: "openai", key: "replacement-api-key" },
        },
        AbortSignal.timeout(10000),
      );
      const replaced = await status();
      assert.equal(replaced.state, "idle");
      assert.equal(replaced.authenticated, false);
      assert.equal(replaced.credentialType, "api_key");
      assert.ok(!replaced.message.includes("已连接"));
    } finally {
      await settings.close();
    }
    catalogFails = false;
    await start();
    await callback();
    assert.equal((await settled()).authenticated, true);
    await server.stop();
    server = await startWorker(directory, { port: 0 });
    worker = new WorkerConnection(directory);
    assert.equal((await status()).authenticated, true);
    await start();
    assert.equal(authorization.searchParams.get("ext_agent_host_id"), hostId);
    await worker.call("/chatgpt-auth", { action: "logout" });
    assert.equal((await status()).authenticated, false);
    assert.equal(await credentials.read("openai"), undefined);
    await start();
    await server.stop();
    assert.equal(
      await realFetch("http://127.0.0.1:1455/auth/callback").catch(() => null),
      null,
      "worker shutdown closes the OAuth listener",
    );
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("subscription configuration rejects alternate endpoints and login messages reject unknown fields", () => {
  const connection = {
    id: "subscription",
    provider: "openai",
    model: "gpt-5.4",
    auth: "chatgpt",
  };
  assert.ok(agentConnectionSchema.safeParse(connection).success);
  for (const patch of [
    { provider: "custom" },
    { api: "openai-responses", baseUrl: "https://example.com/v1" },
    { baseUrl: "https://api.openai.com/v1" },
  ])
    assert.equal(
      agentConnectionSchema.safeParse({ ...connection, ...patch }).success,
      false,
    );
  assert.equal(
    chatGPTAuthRequestSchema.safeParse({
      action: "start",
      id: randomUUID(),
      provider: "other",
    }).success,
    false,
  );
  assert.equal(
    chatGPTAuthRequestSchema.safeParse({ action: "cancel", id: "invalid" })
      .success,
    false,
  );
});

await test("Main rejects unexpected authorization origins and browser failures, cancels the attempt and never leaks the URL", async () => {
  const base: ChatGPTAuthStatus = {
    state: "pending",
    authenticated: false,
    message: "",
    models: [],
  };
  for (const url of [
    "https://evil.example/api/accounts/authorize",
    "https://auth.openai.com/other",
    "https://user@auth.openai.com/api/accounts/authorize",
    "https://auth.openai.com/api/accounts/authorize",
  ]) {
    const requests: unknown[] = [];
    let opened = 0;
    const worker = {
      async call(_path: string, body?: unknown) {
        requests.push(body);
        return { ...base, authorizationUrl: url };
      },
    };
    await assert.rejects(
      requestChatGPTAuth(
        worker,
        { action: "start", id: randomUUID() },
        async () => {
          opened++;
          throw Error("browser unavailable");
        },
      ),
      /无法打开/,
    );
    assert.equal(
      opened,
      url === "https://auth.openai.com/api/accounts/authorize" ? 1 : 0,
    );
    assert.equal(chatGPTAuthRequestSchema.parse(requests[1]).action, "cancel");
  }
});
