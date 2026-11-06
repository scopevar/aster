import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import sharp from "sharp";
import { ValidatedAvatar } from "../src/avatars/image.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";

const request = (command: Command) =>
  envelopeSchema.parse({ id: randomUUID(), command });
await test("Bot copies own new skills, avatar bytes and paused task definitions without private context or authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-copy-")),
    path = join(directory, "db.sqlite");
  let store = new Store(path);
  try {
    const source = store.execute(
      request({ type: "bot.create", name: "source", description: "Purpose" }),
    );
    assert.ok(source.id && source.conversationId);
    const botId = source.id;
    store.execute(
      request({
        type: "bot.preferences",
        botId,
        name: "source",
        description: "Purpose",
        tags: "tag",
        language: "ja",
      }),
    );
    const image = await sharp({
      create: { width: 256, height: 256, channels: 3, background: "#aa2211" },
    })
      .webp()
      .toBuffer();
    const avatar = await ValidatedAvatar.decode(image.toString("base64"));
    store.execute(
      request({
        type: "bot.avatar.image",
        botId,
        revision: 0,
        data: image.toString("base64"),
      }),
      avatar,
    );
    const skillId = randomUUID();
    const skill = {
      type: "skill.save" as const,
      botId,
      id: skillId,
      revision: 0,
      name: "Reusable",
      description: "When requested",
      body: "Version one",
    };
    store.execute(request(skill));
    store.execute(
      request({ ...skill, revision: 1, body: "Current version only" }),
    );
    const routineId = randomUUID();
    store.execute(
      request({
        type: "routine.save",
        id: routineId,
        botId,
        revision: 0,
        name: "Webhook",
        prompt: "Reusable task",
        schedule: { kind: "webhook" },
      }),
    );
    store.execute(
      request({
        type: "routine.key",
        id: routineId,
        botId,
        revision: 1,
        hash: "a".repeat(64),
      }),
    );
    store.execute(
      request({
        type: "routine.state",
        id: routineId,
        botId,
        revision: 2,
        state: "active",
      }),
    );
    store.execute(
      request({
        type: "message.send",
        conversationId: source.conversationId,
        text: "private history",
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    store.runs.setThread(job, "private-thread");
    store.runs.finish(job.id, "completed", null);
    store.execute(
      request({
        type: "draft.save",
        conversationId: source.conversationId,
        text: "private draft",
      }),
    );
    store.files.registerAttachment(
      {
        id: randomUUID(),
        conversationId: source.conversationId,
        name: "private.txt",
      },
      Buffer.from("private bytes"),
    );
    store.execute(
      request({
        type: "memory.save",
        scope: { botId, conversationId: null },
        id: randomUUID(),
        revision: 0,
        topic: "private",
        content: "learned fact",
      }),
    );
    const copyRequest = request({
      type: "bot.copy",
      botId,
      name: "Independent",
      includeSkills: true,
      includeRoutines: true,
    });
    const copy = store.execute(copyRequest);
    assert.ok(copy.id && copy.conversationId);
    assert.deepEqual(store.execute(copyRequest), copy);
    const snapshot = store.views.snapshot({
        conversationId: copy.conversationId,
      }),
      copiedBot = snapshot.bots.find((b) => b.id === copy.id);
    assert.equal(copiedBot?.name, "Independent");
    assert.equal(copiedBot?.description, "Purpose");
    assert.equal(copiedBot?.tags, "tag");
    assert.equal(copiedBot?.language, "ja");
    assert.equal(copiedBot?.avatar.imageHash, avatar.hash);
    assert.equal(copiedBot.avatar.revision, 0);
    assert.equal(snapshot.messages.length, 0);
    assert.equal(snapshot.runs.length, 0);
    const conversation = snapshot.conversations.find(
      (c) => c.id === copy.conversationId,
    );
    assert.equal(conversation?.threadId, null);
    assert.equal(conversation.draft, "");
    assert.deepEqual(conversation.draftAttachments, []);
    assert.equal(
      store.memoryOperations.memoryView({
        botId: copy.id,
        conversationId: null,
      }).entries.length,
      0,
    );
    const copiedSkill = store.skillCatalog([copy.id])[0];
    assert.ok(copiedSkill);
    assert.notEqual(copiedSkill.id, skillId);
    assert.equal(copiedSkill.revision, 1);
    assert.equal(store.skillContent(copiedSkill).body, "Current version only");
    const copiedRoutine = store.routineOperations.view({ botId: copy.id })
      .routines[0];
    assert.ok(copiedRoutine);
    assert.notEqual(copiedRoutine.id, routineId);
    assert.equal(copiedRoutine.state, "paused");
    assert.equal(copiedRoutine.hasKey, false);
    assert.equal(copiedRoutine.nextAt, null);
    store.execute(
      request({
        ...skill,
        botId: copy.id,
        id: copiedSkill.id,
        revision: 1,
        body: "copy edit",
      }),
    );
    assert.equal(
      store.skillContent({ id: skillId, botId, revision: 2 }).body,
      "Current version only",
    );
    store.execute(
      request({
        type: "bot.avatar.character",
        botId: copy.id,
        revision: 0,
        shape: "drop",
        color: "green",
      }),
    );
    assert.equal(
      store.avatarContent({ botId, hash: avatar.hash }).data,
      image.toString("base64"),
    );
    const minimal = store.execute(
      request({
        type: "bot.copy",
        botId,
        name: "Only config",
        includeSkills: false,
        includeRoutines: false,
      }),
    );
    assert.ok(minimal.id);
    assert.equal(store.skillCatalog([minimal.id]).length, 0);
    assert.equal(
      store.routineOperations.view({ botId: minimal.id }).routines.length,
      0,
    );
    store.close();
    store = new Store(path);
    assert.deepEqual(store.execute(copyRequest), copy);
    assert.equal(
      store.skillContent({ ...copiedSkill, revision: 2 }).body,
      "copy edit",
    );
    assert.equal(
      store.views.snapshot({ conversationId: source.conversationId })
        .messages[0]?.text,
      "private history",
    );
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT count(*) n FROM skills WHERE botId=?").get(copy.id)
          ?.n,
        1,
      );
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM thread_owners WHERE botId=?")
          .get(copy.id)?.n,
        0,
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("copy failures roll back all resources and source deletion revokes new copies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-copy-fault-")),
    path = join(directory, "db.sqlite");
  const store = new Store(path),
    db = new DatabaseSync(path);
  try {
    const source = store.execute(
      request({ type: "bot.create", name: "source", description: "" }),
    );
    assert.ok(source.id);
    store.execute(
      request({
        type: "skill.save",
        botId: source.id,
        id: randomUUID(),
        revision: 0,
        name: "Skill",
        description: "description",
        body: "body",
      }),
    );
    const copy = request({
      type: "bot.copy",
      botId: source.id,
      name: "copy",
      includeSkills: true,
      includeRoutines: true,
    });
    db.exec(
      "CREATE TRIGGER fail_copy BEFORE INSERT ON skill_versions BEGIN SELECT RAISE(ABORT,'copy write failed'); END",
    );
    assert.throws(() => store.execute(copy), /copy write failed/);
    assert.equal(db.prepare("SELECT count(*) n FROM bots").get()?.n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM skills").get()?.n, 1);
    assert.equal(
      db.prepare("SELECT count(*) n FROM commands WHERE id=?").get(copy.id)?.n,
      0,
    );
    db.exec("DROP TRIGGER fail_copy");
    store.execute(
      request({
        type: "entity.delete",
        kind: "bot",
        targetId: source.id,
        expectedName: "source",
      }),
    );
    assert.throws(() => store.execute(copy), /删除|清理/);
    assert.equal(db.prepare("SELECT count(*) n FROM bots").get()?.n, 1);
  } finally {
    db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
