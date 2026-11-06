import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentConnections } from "../src/agent/connections.js";
import { JevClient } from "../src/agent/jev.js";
import { jevConfigSchema } from "../src/shared/chat/group-host.js";
import { jevAnswer, jevServer } from "./helpers/jev-server.js";

// Configuration and transport boundaries own validation, credential secrecy and truthful failures.
await test(
  "Jev settings persist separately from secrets and tests do not save unsaved keys",
  { skip: process.platform !== "win32" },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "aster-jev-settings-"));
    const remote = await jevServer((_request, response) =>
      jevAnswer(response, "ready"),
    );
    const service = new AgentConnections(home);
    const signal = () => AbortSignal.timeout(15000);
    try {
      const initial = await service.request({ action: "status" }, signal());
      await service.request(
        { action: "jev.test", config: remote.config, apiKey: "unsaved-key" },
        signal(),
      );
      assert.equal(
        (await service.request({ action: "status" }, signal())).jevHasKey,
        false,
      );
      await assert.rejects(
        service.request(
          {
            action: "save",
            revision: initial.revision,
            config: { ...initial.config, jev: remote.config },
          },
          signal(),
        ),
        /填写 API Key/,
      );
      const saved = await service.request(
        {
          action: "save",
          revision: initial.revision,
          config: { ...initial.config, jev: remote.config },
          jevApiKey: "sealed-jev-key",
        },
        signal(),
      );
      assert.equal(saved.jevHasKey, true);
      assert.equal(saved.config.jev?.baseUrl, remote.config.baseUrl);
      assert.doesNotMatch(JSON.stringify(saved), /sealed-jev-key|unsaved-key/);
      const config = await readFile(join(home, "pi-models.json"), "utf8");
      const sealed = await readFile(join(home, "jev", "pi-auth.sealed"));
      assert.doesNotMatch(config, /sealed-jev-key/);
      assert.ok(!sealed.includes(Buffer.from("sealed-jev-key")));
      const reopened = new AgentConnections(home);
      await reopened.request(
        { action: "jev.test", config: remote.config },
        signal(),
      );
      assert.equal(remote.authorizations.at(-1), "Bearer sealed-jev-key");
      await assert.rejects(
        service.request(
          {
            action: "save",
            revision: initial.revision,
            config: saved.config,
            jevApiKey: "stale-key",
          },
          signal(),
        ),
        /配置已修改/,
      );
      await reopened.request(
        { action: "jev.test", config: remote.config },
        signal(),
      );
      assert.equal(remote.authorizations.at(-1), "Bearer sealed-jev-key");
    } finally {
      await remote.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

await test("Jev rejects unsafe URLs, invalid decisions and HTTP errors without disclosing provider bodies", async () => {
  for (const baseUrl of [
    "http://remote.example/v1",
    "https://key:secret@example.com/v1",
    "https://example.com/v1?key=secret",
    "file:///tmp/key",
    "https://example.com/#secret",
  ])
    assert.equal(jevConfigSchema.safeParse({ baseUrl }).success, false);
  let mode = "outside";
  const remote = await jevServer((_request, response) => {
    if (mode === "outside") jevAnswer(response, "not-a-candidate");
    else if (mode === "invalid") {
      response.writeHead(200);
      response.end('{"answers":{"next":{"choice":"ready"}}}');
    } else if (mode === "distribution") {
      response.writeHead(200);
      response.end(
        JSON.stringify({
          answers: {
            next: {
              type: "choice",
              choice: "ready",
              confidence: 1,
              probabilities: { ready: 0.2 },
            },
          },
        }),
      );
    } else {
      response.writeHead(401);
      response.end("sensitive provider debug data");
    }
  });
  const client = new JevClient(remote.config, "secret-key");
  const choose = () =>
    client.choose({}, { ready: "ready" }, "select", AbortSignal.timeout(5000));
  try {
    await assert.rejects(choose(), /候选范围以外/);
    mode = "invalid";
    await assert.rejects(choose(), /判断格式无效/);
    mode = "distribution";
    await assert.rejects(choose(), /概率分布无效/);
    mode = "unauthorized";
    await assert.rejects(
      choose(),
      (error: unknown) =>
        error instanceof Error &&
        /HTTP 401/.test(error.message) &&
        !/secret-key|sensitive/.test(error.message),
    );
  } finally {
    await remote.close();
  }
});
