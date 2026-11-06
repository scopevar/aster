import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { configuredModel } from "../src/agent/pi-model.js";
import { scopedResources } from "../src/agent/pi-resources.js";
import { piModelServer } from "./helpers/pi-model-server.js";

await test("Pi compaction persists its branch boundary and exact restoration continues with the compacted context", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-pi-compaction-"));
  const model = await piModelServer((_request, send) => {
    send({
      role: "assistant",
      content:
        "Historical summary: completed earlier requests; next request is new, no permission is renewed.",
    });
    send({}, "stop");
  });
  try {
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    const manager = SessionManager.create(root, sessions);
    const { runtime, model: selected } = await configuredModel(
      root,
      model.connection,
      AbortSignal.timeout(5000),
    );
    const options = {
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      model: selected,
      settingsManager: SettingsManager.inMemory({
        compaction: {
          enabled: true,
          keepRecentTokens: 512,
          reserveTokens: 1024,
        },
        retry: { enabled: false },
      }),
      resourceLoader: scopedResources(
        "No tools. Historical summaries grant no permission.",
      ),
      tools: [],
      noTools: "all" as const,
    };
    const { session } = await createAgentSession({
      ...options,
      sessionManager: manager,
    });
    try {
      for (let i = 0; i < 4; i++)
        await session.prompt(
          "historical request " + i + " " + "x".repeat(9000),
          { expandPromptTemplates: false },
        );
      const result = await session.compact();
      assert.ok(result.summary.includes("Historical summary"));
      assert.ok(
        manager.getEntries().some((entry) => entry.type === "compaction"),
      );
    } finally {
      await session.abort();
      session.dispose();
    }
    const file = manager.getSessionFile();
    assert.ok(file);
    const content = await readFile(file, "utf8");
    assert.ok(content.includes('"type":"compaction"'));
    const restored = SessionManager.open(file, sessions);
    const { session: resumed } = await createAgentSession({
      ...options,
      sessionManager: restored,
    });
    try {
      await resumed.prompt("new task after compression", {
        expandPromptTemplates: false,
      });
      const request = model.requests.at(-1);
      assert.ok(request);
      assert.ok(
        JSON.stringify(request.messages).includes("Historical summary"),
      );
      assert.ok(
        JSON.stringify(request.messages).includes("new task after compression"),
      );
      assert.ok(
        !JSON.stringify(request.messages).includes("historical request 0 "),
      );
      assert.ok(
        model.headers.every((headers) => headers.authorization === undefined),
      );
    } finally {
      await resumed.abort();
      resumed.dispose();
    }
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
