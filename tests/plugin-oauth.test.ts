import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Store } from "../src/storage/store.js";
import { aesSecretBox } from "../src/security/secret-box.js";
import { OAuthCredentialStore } from "../src/plugins/oauth-credentials.js";
import { PluginOAuth } from "../src/plugins/oauth.js";
import { PluginService } from "../src/plugins/service.js";
import { PluginSession } from "../src/plugins/session.js";
import { pluginContentSchema } from "../src/shared/tools/plugins.js";
import { pluginOAuthFixture } from "./helpers/plugin-oauth.js";
import { z } from "zod";

async function setup(transport: "http" | "sse" = "http") {
  const root = resolve(".runtime/test-results");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "plugin-oauth-"));
  const fixture = await pluginOAuthFixture(transport);
  const store = new Store(join(directory, "test.sqlite"));
  const bot = store.execute({
    id: randomUUID(),
    command: { type: "bot.create", name: "OAuth", description: "" },
  });
  assert.ok(bot.id && bot.conversationId);
  const id = randomUUID(),
    botId = bot.id;
  store.plugins.install(
    botId,
    id,
    pluginContentSchema.parse({
      name: "oauth-test",
      description: "",
      version: "1",
      format: "generic",
      skills: [],
      variables: [],
      warnings: [],
      files: {},
      servers: {
        remote: {
          url: fixture.url,
          type: transport,
          headers: { "X-Plugin-Secret": "resource-only" },
        },
      },
    }),
    {},
    true,
  );
  const box = aesSecretBox(randomBytes(32));
  const credentials = new OAuthCredentialStore(join(directory, "auth"), box);
  let oauth = new PluginOAuth(store, credentials),
    service = new PluginService(store, oauth);
  const controller = new AbortController();
  return {
    fixture,
    store,
    directory,
    credentials,
    box,
    id,
    botId,
    controller,
    get oauth() {
      return oauth;
    },
    get service() {
      return service;
    },
    async restart() {
      await oauth.close();
      service.close();
      oauth = new PluginOAuth(store, credentials);
      service = new PluginService(store, oauth);
    },
    async begin() {
      const value = await service.request(
        { action: "authorize", botId, id, server: "remote" },
        controller.signal,
      );
      assert.ok(value.authorizationUrl);
      return value.authorizationUrl;
    },
    async state() {
      return (
        await service.request({ action: "list", botId }, controller.signal)
      ).plugins[0]?.servers[0]?.authorization?.state;
    },
    async wait(state: string) {
      for (let i = 0; i < 150; i++) {
        if ((await this.state()) === state) return;
        await delay(10);
      }
      assert.equal(await this.state(), state);
    },
    async session() {
      store.execute({
        id: randomUUID(),
        command: {
          type: "message.send",
          conversationId: bot.conversationId ?? "",
          text: "Use MCP",
        },
      });
      const job = store.runs.claim();
      assert.ok(job);
      return {
        job,
        session: new PluginSession(store, job, controller.signal, oauth),
      };
    },
    async close() {
      controller.abort();
      service.close();
      await oauth.close();
      store.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// Contract: an actual protected MCP becomes usable only after a PKCE browser round trip;
// refreshed credentials survive restart and do not bypass the existing per-call approval.
await test("OAuth authorizes real MCP, seals tokens, refreshes after restart and retains tool approval", async () => {
  const env = await setup();
  let running: Awaited<ReturnType<typeof env.session>> | undefined;
  try {
    const before = await env.session();
    running = before;
    const denied = z
      .object({
        tools: z.array(z.unknown()),
        errors: z.array(z.object({ message: z.string() })),
      })
      .parse(
        await before.session.request(
          { callId: "before", operation: { action: "list" } },
          env.controller.signal,
        ),
      );
    assert.equal(denied.tools.length, 0);
    assert.match(denied.errors[0]?.message ?? "", /连接|授权/);
    assert.equal(env.fixture.exchanges, 0);
    await before.session.close();
    env.store.runs.finish(before.job.id, "completed", null);
    running = undefined;
    const url = await env.begin();
    assert.equal(await env.state(), "pending");
    const { response, target } = await env.fixture.approve(url);
    assert.equal(response.status, 200);
    await env.wait("connected");
    assert.equal(env.fixture.exchanges, 1);
    const serialized = JSON.stringify(
      await env.service.request(
        { action: "list", botId: env.botId },
        env.controller.signal,
      ),
    );
    assert.ok(
      !serialized.includes(env.fixture.token) &&
        !serialized.includes(env.fixture.refresh),
    );
    for (const path of await readdir(join(env.directory, "auth", env.botId))) {
      const saved = await readFile(
        join(env.directory, "auth", env.botId, path),
      );
      assert.ok(
        !saved.includes(Buffer.from(env.fixture.token)) &&
          !saved.includes(Buffer.from(env.fixture.refresh)),
      );
    }
    await assert.rejects(fetch(target), /fetch failed/);
    await env.restart();
    assert.equal(await env.state(), "connected");
    env.fixture.expire();
    running = await env.session();
    const catalog = z
      .object({
        tools: z.array(z.object({ name: z.string() })),
        errors: z.array(z.unknown()),
      })
      .parse(
        await running.session.request(
          { callId: "list", operation: { action: "list" } },
          env.controller.signal,
        ),
      );
    assert.equal(catalog.tools[0]?.name, "protected");
    assert.deepEqual(catalog.errors, []);
    assert.equal(env.fixture.refreshes, 1);
    assert.deepEqual(env.fixture.leakedHeaders, []);
    const call = running.session.request(
      {
        callId: "call",
        operation: {
          action: "call",
          pluginId: env.id,
          server: "remote",
          tool: "protected",
          arguments: {},
        },
      },
      env.controller.signal,
    );
    let approvalId: string | undefined;
    for (let i = 0; i < 100 && !approvalId; i++) {
      approvalId = env.store.views
        .snapshot({ conversationId: running.job.conversationId })
        .messages.find((message) => message.pluginCall?.status === "pending")
        ?.pluginCall?.id;
      if (!approvalId) await delay(10);
    }
    assert.ok(approvalId);
    assert.equal(env.fixture.performed, 0);
    env.store.pluginCalls.decide(env.botId, approvalId, true);
    await call;
    assert.equal(env.fixture.performed, 1);
    await env.service.request(
      { action: "disconnect", botId: env.botId, id: env.id, server: "remote" },
      env.controller.signal,
    );
    assert.equal(await env.state(), "disconnected");
    assert.equal(
      (await readdir(join(env.directory, "auth", env.botId))).length,
      0,
    );
  } finally {
    await running?.session.close();
    await env.close();
  }
});

await test("OAuth rejects forged state, issuer mismatch, denial and cancellation without redeeming codes", async () => {
  for (const scenario of ["state", "issuer", "denial", "cancel"] as const) {
    const env = await setup();
    try {
      if (scenario === "issuer") env.fixture.wrongIssuer();
      if (scenario === "denial") env.fixture.deny();
      const url = await env.begin();
      const response = await fetch(url, { redirect: "manual" });
      const location = response.headers.get("location");
      assert.ok(location);
      if (scenario === "cancel") {
        await env.service.request(
          {
            action: "disconnect",
            botId: env.botId,
            id: env.id,
            server: "remote",
          },
          env.controller.signal,
        );
        await assert.rejects(fetch(location));
        assert.equal(await env.state(), "disconnected");
      } else if (scenario === "state") {
        const forged = new URL(location);
        forged.searchParams.set("state", "forged");
        assert.equal((await fetch(forged)).status, 400);
        assert.equal(await env.state(), "pending");
      } else {
        await fetch(location);
        await env.wait("failed");
      }
      assert.equal(env.fixture.exchanges, 0);
    } finally {
      await env.close();
    }
  }
});

await test("OAuth grants do not cross Bots, changed plugin configuration or account credential stores", async () => {
  const env = await setup();
  try {
    await env.fixture.approve(await env.begin());
    await env.wait("connected");
    const other = env.store.execute({
      id: randomUUID(),
      command: { type: "bot.create", name: "Other", description: "" },
    });
    assert.ok(other.id);
    await assert.rejects(
      env.oauth.transport(other.id, env.id, "remote"),
      /不属于/,
    );
    await env.oauth.close();
    const otherAccount = new PluginOAuth(
      env.store,
      new OAuthCredentialStore(
        join(env.directory, "other-account"),
        aesSecretBox(randomBytes(32)),
      ),
    );
    try {
      assert.equal(
        (await otherAccount.status(env.botId, env.id, "remote"))?.state,
        "disconnected",
      );
    } finally {
      await otherAccount.close();
    }
    await env.restart();
    env.store.plugins.configure(env.botId, env.id, false);
    env.store.plugins.configure(env.botId, env.id, true);
    assert.equal(await env.state(), "disconnected");
    assert.deepEqual(await readdir(join(env.directory, "auth", env.botId)), []);
    env.store.plugins.configure(env.botId, env.id, true, { CHANGED: "yes" });
    assert.equal(await env.state(), "disconnected");
  } finally {
    await env.close();
  }
});

await test("SSE MCP reuses browser authorization and refreshes expired credentials", async () => {
  const env = await setup("sse");
  let running: Awaited<ReturnType<typeof env.session>> | undefined;
  try {
    await env.fixture.approve(await env.begin());
    await env.wait("connected");
    env.fixture.expire();
    running = await env.session();
    const result = z
      .object({
        tools: z.array(z.object({ name: z.string() })),
        errors: z.array(z.unknown()),
      })
      .parse(
        await running.session.request(
          { callId: "sse-list", operation: { action: "list" } },
          env.controller.signal,
        ),
      );
    assert.equal(result.tools[0]?.name, "protected");
    assert.deepEqual(result.errors, []);
    assert.equal(env.fixture.refreshes, 1);
    assert.deepEqual(env.fixture.leakedHeaders, []);
  } finally {
    await running?.session.close();
    await env.close();
  }
});

await test("a revoked refresh grant asks for login without opening a browser or executing tools", async () => {
  const env = await setup();
  let running: Awaited<ReturnType<typeof env.session>> | undefined;
  try {
    await env.fixture.approve(await env.begin());
    await env.wait("connected");
    await env.restart();
    env.fixture.expire();
    env.fixture.rejectRefresh();
    running = await env.session();
    const result = z
      .object({
        tools: z.array(z.unknown()),
        errors: z.array(z.object({ message: z.string() })),
      })
      .parse(
        await running.session.request(
          { callId: "expired", operation: { action: "list" } },
          env.controller.signal,
        ),
      );
    assert.equal(result.tools.length, 0);
    assert.match(result.errors[0]?.message ?? "", /连接|授权/);
    assert.equal(env.fixture.exchanges, 1);
    assert.equal(env.fixture.performed, 0);
    assert.equal(await env.state(), "failed");
  } finally {
    await running?.session.close();
    await env.close();
  }
});

await test("legacy OAuth credentials without an issuer are retained but cannot be sent or refreshed before reconnecting", async () => {
  const env = await setup();
  try {
    await env.fixture.approve(await env.begin());
    await env.wait("connected");
    const key = `${env.botId}/${env.id}/remote`;
    const credentialDirectory = join(env.directory, "auth", env.botId);
    const files = await readdir(credentialDirectory);
    assert.equal(files.length, 1);
    const path = join(credentialDirectory, files[0]!);
    const raw: unknown = JSON.parse(
      Buffer.from(await env.box.open(await readFile(path))).toString("utf8"),
    );
    const { scope } = z.object({ scope: z.string() }).parse(raw);
    const data = await env.credentials.read(key, scope);
    assert.ok(data?.client?.issuer && data.tokens?.issuer);
    delete data.client.issuer;
    delete data.tokens.issuer;
    await env.credentials.save(key, data, () => {});
    const legacy = await readFile(path);
    await env.restart();
    assert.equal(await env.state(), "failed");
    const transport = await env.oauth.transport(env.botId, env.id, "remote");
    assert.ok(transport);
    await assert.rejects(transport.provider.token(), /授权服务器.*重新连接/);
    assert.equal(env.fixture.refreshes, 0);
    assert.deepEqual(await readFile(path), legacy);
    await env.fixture.approve(await env.begin());
    await env.wait("connected");
  } finally {
    await env.close();
  }
});

await test("disconnect during token exchange prevents late credentials, and Bot deletion removes sealed grants", async () => {
  const env = await setup();
  try {
    env.fixture.holdToken();
    await env.fixture.approve(await env.begin());
    for (let i = 0; i < 100 && !env.fixture.exchanges; i++) await delay(10);
    assert.equal(env.fixture.exchanges, 1);
    await env.service.request(
      { action: "disconnect", botId: env.botId, id: env.id, server: "remote" },
      env.controller.signal,
    );
    assert.equal(await env.state(), "disconnected");
    await assert.rejects(
      readdir(join(env.directory, "auth", env.botId)),
      /ENOENT/,
    );
  } finally {
    await env.close();
  }
  const other = await setup();
  try {
    await other.fixture.approve(await other.begin());
    await other.wait("connected");
    await other.oauth.removeBot(other.botId);
    await assert.rejects(
      readdir(join(other.directory, "auth", other.botId)),
      /ENOENT/,
    );
  } finally {
    await other.close();
  }
});
