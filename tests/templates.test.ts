import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { envelopeSchema } from "../src/shared/commands.js";
import { resultSchema } from "../src/shared/core.js";
import { snapshotUpdateSchema } from "../src/shared/snapshot.js";
import {
  templatesResponseSchema,
  templatePayloadSchema,
} from "../src/shared/templates/templates.js";
import { portableTemplate } from "../src/shared/templates/portable-template.js";
import { defaultAvatar } from "../src/shared/avatar.js";
import { callWorker } from "../src/worker/client.js";
import { startWorker } from "../src/worker/server.js";

// Owner: authenticated worker commands, actual SQLite import and explicit portable export.
await test("local templates export selected content and import independent Bots with paused tasks and original request receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-local-template-"));
  const worker = await startWorker(root, { port: 0 });
  const send = async (command: unknown) =>
    resultSchema.parse(
      await callWorker(
        worker.endpoint,
        "/command",
        envelopeSchema.parse({ id: randomUUID(), command }),
      ),
    );
  try {
    const source = await send({
      type: "bot.create",
      name: "Source",
      description: "portable instructions",
    });
    assert.ok(source.id && source.conversationId);
    await send({
      type: "draft.save",
      conversationId: source.conversationId,
      text: "PRIVATE_CHAT_CANARY",
    });
    await send({
      type: "skill.save",
      id: randomUUID(),
      botId: source.id,
      revision: 0,
      name: "Selected",
      description: "guide",
      body: "portable skill",
    });
    await send({
      type: "skill.save",
      id: randomUUID(),
      botId: source.id,
      revision: 0,
      name: "Private",
      description: "private",
      body: "PRIVATE_SKILL_CANARY",
    });
    await send({
      type: "routine.save",
      id: randomUUID(),
      botId: source.id,
      revision: 0,
      name: "Routine",
      prompt: "portable task",
      schedule: { kind: "webhook" },
    });
    const created = await send({
      type: "template.create",
      botId: source.id,
      includeSkills: true,
      includeRoutines: true,
    });
    assert.ok(created.id);
    const captured = templatesResponseSchema.parse(
      await callWorker(worker.endpoint, "/templates/query", {
        kind: "draft",
        id: created.id,
      }),
    );
    assert.equal(captured.kind, "draft");
    if (captured.kind !== "draft") throw Error("Missing draft");
    const selectedSkill = captured.data.payload.skills.findIndex(
      (skill) => skill.name === "Selected",
    );
    const exported = templatesResponseSchema.parse(
      await callWorker(worker.endpoint, "/templates/query", {
        kind: "export",
        id: created.id,
        revision: 1,
        selection: {
          configuration: true,
          skills: [selectedSkill],
          routines: [0],
          plugins: [],
        },
      }),
    );
    assert.equal(exported.kind, "export");
    if (exported.kind !== "export") throw Error("Missing export");
    assert.equal(exported.data.skills.length, 1);
    assert.equal(exported.data.skills[0]?.name, "Selected");
    assert.doesNotMatch(
      JSON.stringify(exported.data),
      /PRIVATE_CHAT_CANARY|PRIVATE_SKILL_CANARY|connectionId|keyHash|directory_grants/,
    );
    const payload = templatePayloadSchema.parse({
      ...exported.data,
      plugins: [{ name: "my-plugin", version: "1.0" }],
    });
    const request = envelopeSchema.parse({
      id: randomUUID(),
      command: { type: "template.import", payload },
    });
    const imported = resultSchema.parse(
      await callWorker(worker.endpoint, "/command", request),
    );
    assert.deepEqual(
      await callWorker(worker.endpoint, "/command", request),
      imported,
    );
    assert.notEqual(imported.id, source.id);
    const view = snapshotUpdateSchema.parse(
      await callWorker(worker.endpoint, "/snapshot", {
        conversationId: imported.conversationId,
      }),
    );
    assert.ok(view.changed);
    assert.equal(view.snapshot.bots.length, 2);
    assert.equal(view.snapshot.messages.length, 0);
    const routines = await callWorker(
      worker.endpoint,
      `/routines?botId=${imported.id}`,
    );
    const { routineViewSchema } = await import("../src/shared/routines.js");
    assert.equal(
      routineViewSchema.parse(routines).routines[0]?.state,
      "paused",
    );
    const plugins = await callWorker(worker.endpoint, "/plugins", {
      action: "list",
      botId: imported.id,
    });
    assert.deepEqual(plugins, { plugins: [], preview: null, notice: "" });
    const local = templatesResponseSchema.parse(
      await callWorker(worker.endpoint, "/templates/query", { kind: "local" }),
    );
    assert.equal(local.kind, "local");
    if (local.kind === "local")
      assert.equal(
        local.data.drafts.length,
        2,
        "import retains the dependency declaration in a local draft",
      );
    await assert.rejects(
      callWorker(worker.endpoint, "/templates/query", {
        kind: "export",
        id: created.id,
        revision: 999,
        selection: {
          configuration: true,
          skills: [],
          routines: [],
          plugins: [],
        },
      }),
      /模板已改变/,
    );
    await assert.rejects(
      callWorker(worker.endpoint, "/command", {
        id: randomUUID(),
        command: {
          type: "template.publish",
          id: created.id,
          revision: 1,
          action: "publish",
        },
      }),
      /命令格式无效/,
    );
  } finally {
    await worker.stop();
    await rm(root, { recursive: true, force: true });
  }
});

await test("template boundaries reject unknown secret fields, embedded keys and absolute paths before exporting", () => {
  const base = templatePayloadSchema.parse({
    format: 1,
    name: "Portable",
    description: "",
    tags: "",
    language: "auto",
    avatar: { shape: "blob", color: "gray", image: null },
    skills: [],
    routines: [],
  });
  const all = { configuration: true, skills: [], routines: [], plugins: [] };
  assert.deepEqual(
    portableTemplate(base, { ...all, configuration: false }).avatar,
    { shape: defaultAvatar.shape, color: defaultAvatar.color, image: null },
  );
  assert.equal(
    templatePayloadSchema.safeParse({ ...base, apiKey: "private-canary" })
      .success,
    false,
  );
  for (const description of [
    "sk-abcdefghijklmnopqrstuvwxyz123456",
    "Bearer private-token-value",
    "C:\\Users\\private\\notes.txt",
    "/home/alice/private.txt",
    "Steps:\n/home/alice/private.txt",
    "`/home/alice/private.txt`",
    "/用户/私人文件.txt",
    "file:///private/token",
    "https://user:private-password@example.com/data",
  ]) {
    assert.throws(
      () => portableTemplate({ ...base, description }, all),
      /密钥|令牌|路径/,
    );
    assert.equal(
      portableTemplate(
        { ...base, description },
        { ...all, configuration: false },
      ).description,
      "",
    );
  }
  assert.equal(
    portableTemplate(
      { ...base, description: "Use ./notes and https://example.com/docs" },
      all,
    ).description,
    "Use ./notes and https://example.com/docs",
  );
  assert.equal(
    portableTemplate(
      {
        ...base,
        description: "Use /workspace/report.txt and /inputs/source.txt",
      },
      all,
    ).description,
    "Use /workspace/report.txt and /inputs/source.txt",
  );
});
