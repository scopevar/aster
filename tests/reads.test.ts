import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { Store } from "../src/storage/store.js";
import { SandboxService } from "../src/sandbox/service.js";
import { ToolService } from "../src/tools/service.js";
import { type Command } from "../src/shared/commands.js";
import { readResultSchema } from "../src/shared/files/reads.js";
import { samplePdf } from "./helpers/pdf.js";

// The real scoped service owns these contracts: readable bytes/images, live grants,
// conversation history and skill revisions. VM execution is covered by microsandbox.test.ts.
await test("read exposes scoped text/images, skill versions and history without requiring a running VM", async () => {
  const results = resolve(".runtime/test-results");
  await mkdir(results, { recursive: true });
  const root = await mkdtemp(join(results, "reads-"));
  const store = new Store(":memory:");
  const execute = (command: Command) =>
    store.execute({ id: randomUUID(), command });
  const bot = execute({ type: "bot.create", name: "Reader", description: "" });
  const other = execute({ type: "bot.create", name: "Other", description: "" });
  assert.ok(bot.id && bot.conversationId && other.id && other.conversationId);
  const conversationId = bot.conversationId;
  const skillId = randomUUID(),
    hiddenSkill = randomUUID();
  execute({
    type: "skill.save",
    botId: bot.id,
    id: skillId,
    revision: 0,
    name: "Local skill",
    description: "when requested",
    body: "LOCAL_SKILL_BODY",
  });
  execute({
    type: "skill.save",
    botId: other.id,
    id: hiddenSkill,
    revision: 0,
    name: "Other skill",
    description: "private",
    body: "OTHER_SKILL_BODY",
  });
  execute({
    type: "message.send",
    conversationId: other.conversationId,
    text: "OTHER_HISTORY",
  });
  const otherJob = store.runs.claim();
  assert.ok(otherJob);
  store.runs.finish(otherJob.id, "completed", null);
  execute({ type: "message.send", conversationId, text: "ARCHIVED_HISTORY" });
  const previous = store.runs.claim();
  assert.ok(previous);
  const long = "中文😀".repeat(6000) + "HISTORY_END";
  store.runs.output.writeText(previous, "long", long, true);
  store.runs.finish(previous.id, "completed", null);
  execute({ type: "message.send", conversationId, text: "CURRENT_HIDDEN" });
  const job = store.runs.claim();
  assert.ok(job);
  const work = join(root, "workspaces", bot.id, "script-work");
  const outside = join(root, "private");
  const grantRoot = join(root, "granted");
  await mkdir(work, { recursive: true });
  await mkdir(outside);
  await mkdir(grantRoot);
  await writeFile(join(work, "text.txt"), "READ_TEXT_中文");
  await writeFile(join(work, "unicode.txt"), "😀X");
  const image = await sharp({
    create: { width: 16, height: 12, channels: 3, background: "#0000ff" },
  })
    .png()
    .toBuffer();
  await writeFile(join(work, "blue.png"), image);
  await writeFile(join(outside, "secret.txt"), "HOST_PRIVATE");
  await link(join(outside, "secret.txt"), join(work, "hardlink.txt"));
  await writeFile(
    join(grantRoot, "paper.pdf"),
    samplePdf("GRANTED_PDF", "SCAN"),
  );
  const grant = execute({
    type: "directory.attach",
    conversationId,
    root: grantRoot,
  });
  assert.ok(grant.id);
  const sandbox = new SandboxService(store, root);
  const tools = new ToolService(store, 12345, undefined, undefined, sandbox);
  const scope = tools.open(job, new AbortController().signal);
  const read = async (path: string, offset = 0, limit = 16384) =>
    readResultSchema.parse(
      await tools.read(
        scope.connection.token,
        { callId: randomUUID(), path, offset, limit },
        new AbortController().signal,
      ),
    );
  try {
    const text = await read("/workspace/text.txt", 5, 4);
    assert.ok(text.type === "text");
    assert.equal(text.text, "TEXT");
    assert.equal(text.nextOffset, 9);
    await assert.rejects(read("/workspace/text.txt", 999), /超过/);
    const unicode = await read("/workspace/unicode.txt", 0, 1);
    assert.ok(unicode.type === "text");
    assert.equal(unicode.text, "😀");
    assert.equal(unicode.nextOffset, 2);
    const picture = await read("/workspace/blue.png");
    assert.ok(picture.type === "image");
    const pixel = await sharp(Buffer.from(picture.data, "base64"))
      .raw()
      .toBuffer();
    assert.deepEqual([...pixel.subarray(0, 3)], [0, 0, 255]);
    const directory = await read("/workspace");
    assert.ok(directory.type === "directory");
    assert.ok(
      directory.entries.some((entry) => entry.path === "/workspace/text.txt"),
    );
    for (const path of [
      "/workspace/../private/secret.txt",
      "/workspace/hardlink.txt",
      "/etc/passwd",
      "C:\\Users\\secret",
      `/skills/${hiddenSkill}/1/SKILL.md`,
    ])
      await assert.rejects(read(path));
    const skills = await read("/skills");
    assert.ok(skills.type === "directory");
    assert.deepEqual(
      skills.entries.map((entry) => entry.path),
      [`/skills/${skillId}/1/SKILL.md`],
    );
    const body = await read(skills.entries[0]!.path);
    assert.ok(body.type === "text");
    assert.equal(body.text, "LOCAL_SKILL_BODY");
    execute({
      type: "skill.save",
      botId: bot.id,
      id: skillId,
      revision: 1,
      name: "Local skill",
      description: "changed",
      body: "V2",
    });
    await assert.rejects(read(`/skills/${skillId}/1/SKILL.md`), /版本已改变/);
    const history = await read("/history");
    assert.ok(history.type === "directory");
    assert.doesNotMatch(
      JSON.stringify(history),
      /OTHER_HISTORY|CURRENT_HIDDEN/,
    );
    const archived = history.entries.find((entry) =>
      entry.name.startsWith("assistant:"),
    );
    assert.ok(archived);
    let offset = 0,
      full = "";
    for (;;) {
      const chunk = await read(archived.path, offset, 10000);
      assert.ok(chunk.type === "text");
      full += chunk.text;
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
    assert.equal(full, long);
    await assert.rejects(read("/desktop/desktop.txt"), /不属于当前可读范围/);
    const roots = await read("/");
    assert.ok(roots.type === "directory");
    assert.deepEqual(
      roots.entries.map((entry) => entry.name),
      ["inputs", "workspace", "skills", "history", "grants"],
    );
    const imported = await read(`/grants/${grant.id}/paper.pdf`);
    assert.ok(imported.type === "file");
    assert.match(imported.shellPath, /^\/inputs\/read-[a-f0-9]+\.pdf$/);
    const received = await read(imported.shellPath);
    assert.ok(received.type === "file");
    assert.equal(received.hash, imported.hash);
    execute({ type: "directory.revoke", conversationId, id: grant.id });
    await assert.rejects(read(`/grants/${grant.id}/paper.pdf`), /授权/);
    await assert.rejects(access(join(root, "scripts", "runtime")));
    store.runs.finish(job.id, "completed", null);
    await assert.rejects(read("/workspace/text.txt"), /运行已结束/);
  } finally {
    await scope.close();
    await sandbox.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
