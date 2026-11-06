import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";
const request = (command: Command) =>
  envelopeSchema.parse({ id: randomUUID(), command });
await test("late group member cannot receive silently truncated or unbounded skill history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-skill-budget-"));
  const store = new Store(join(directory, "db.sqlite"));
  try {
    const a = store.execute(
        request({ type: "bot.create", name: "A", description: "" }),
      ).id,
      b = store.execute(
        request({ type: "bot.create", name: "B", description: "" }),
      ).id;
    assert.ok(a && b);
    const refs = Array.from({ length: 4 }, (_, index) => {
      const id = randomUUID();
      store.execute(
        request({
          type: "skill.save",
          id,
          botId: a,
          revision: 0,
          name: "技能" + index,
          description: "容量验证",
          body: "x".repeat(32000),
        }),
      );
      return { id, botId: a, revision: 1 };
    });
    const group = store.execute(
      request({
        type: "group.start",
        memberIds: [a],
        text: "执行",
        skills: refs,
      }),
    );
    assert.ok(group.conversationId);
    const initial = store.runs.claim();
    assert.ok(initial);
    for (let i = 0; i < 2; i++) {
      const turn = store.runs.nextGroupTurn(initial);
      assert.ok(turn);
      store.runs.finishGroupTurn(turn, "completed", null);
    }
    store.runs.finish(initial.id, "completed", null);
    store.execute(
      request({
        type: "group.update",
        conversationId: group.conversationId,
        revision: 0,
        name: "群聊",
        description: "",
        memberIds: [a, b],
      }),
    );
    store.execute(
      request({
        type: "message.send",
        conversationId: group.conversationId,
        text: "再执行",
        skills: refs,
      }),
    );
    const parent = store.runs.claim();
    assert.ok(parent);
    const turn = store.runs.nextGroupTurn(parent);
    assert.ok(turn);
    store.runs.finishGroupTurn(turn, "completed", null);
    assert.throws(() => store.runs.nextGroupTurn(parent), /未截断技能/);
    assert.equal(store.runs.getRun(parent.id)?.groupTurns[1]?.status, "queued");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
await test("skills retain frozen revisions, enforce owner and optimistic updates, recover drafts and reject deleted references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-skills-"));
  let store = new Store(join(directory, "db.sqlite"));
  try {
    const first = store.execute(
      request({ type: "bot.create", name: "A", description: "" }),
    );
    const other = store.execute(
      request({ type: "bot.create", name: "B", description: "" }),
    );
    assert.ok(
      first.id && first.conversationId && other.id && other.conversationId,
    );
    const id = randomUUID(),
      body = "FIRST_RANDOM_" + randomUUID();
    const save = request({
      type: "skill.save",
      id,
      botId: first.id,
      revision: 0,
      name: "校验",
      description: "输出校验词",
      body,
    });
    store.execute(save);
    store.execute(save);
    const ref = { id, botId: first.id, revision: 1 };
    assert.throws(
      () =>
        store.execute(
          request({
            type: "skills.select",
            conversationId: other.conversationId!,
            references: [ref],
            text: "",
          }),
        ),
      /当前 Bot/,
    );
    store.execute(
      request({
        type: "skills.select",
        conversationId: first.conversationId,
        references: [ref],
        text: "执行",
      }),
    );
    store.close();
    store = new Store(join(directory, "db.sqlite"));
    assert.equal(
      store.views
        .snapshot({ conversationId: first.conversationId })
        .conversations.find((c) => c.id === first.conversationId)
        ?.draftSkills[0]?.revision,
      1,
    );
    store.execute(
      request({
        type: "skill.save",
        id,
        botId: first.id,
        revision: 1,
        name: "校验",
        description: "输出校验词",
        body: "SECOND",
      }),
    );
    assert.throws(
      () =>
        store.execute(
          request({
            type: "skill.save",
            id,
            botId: first.id!,
            revision: 1,
            name: "校验",
            description: "冲突",
            body: "STALE",
          }),
        ),
      /已修改/,
    );
    const run = store.execute(
      request({
        type: "message.send",
        conversationId: first.conversationId,
        text: "执行",
        skills: [ref],
      }),
    );
    assert.ok(run.id);
    assert.equal(
      store.views.snapshot({ conversationId: first.conversationId }).messages[0]
        ?.skills[0]?.revision,
      1,
    );
    const job = store.runs.claim();
    assert.ok(job?.text.includes(body));
    assert.ok(!job?.text.includes("SECOND"));
    store.runs.finish(run.id, "completed", null);
    store.execute(
      request({ type: "skill.delete", id, botId: first.id, revision: 2 }),
    );
    assert.throws(
      () =>
        store.execute(
          request({
            type: "message.send",
            conversationId: first.conversationId!,
            text: "执行",
            skills: [ref],
          }),
        ),
      /已删除/,
    );
    assert.equal(store.skillContent(ref).body, body);
    assert.throws(
      () => store.skillContent({ ...ref, botId: other.id! }),
      /不属于/,
    );
    assert.equal(
      store.views.snapshot({ conversationId: first.conversationId }).skills
        .length,
      0,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("group skill sharing uses only explicit message references and stale drafts can be cleared", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-skill-group-"));
  const store = new Store(join(directory, "db.sqlite"));
  try {
    const a = store.execute(
      request({ type: "bot.create", name: "A", description: "" }),
    ).id;
    const b = store.execute(
      request({ type: "bot.create", name: "B", description: "" }),
    ).id;
    assert.ok(a && b);
    const refs = [a, b].map((botId) => ({
      id: randomUUID(),
      botId,
      revision: 1,
    }));
    for (const ref of refs)
      store.execute(
        request({
          type: "skill.save",
          ...ref,
          revision: 0,
          name: "测试",
          description: "复用",
          body: "ONLY_" + ref.botId,
        }),
      );
    const group = store.execute(
      request({ type: "group.start", memberIds: [a, b], text: "开始" }),
    );
    assert.ok(group.conversationId);
    const first = store.runs.claim();
    assert.ok(first);
    store.runs.finish(first.id, "completed", null);
    store.execute(
      request({
        type: "skills.select",
        conversationId: group.conversationId,
        references: refs,
        text: "执行",
      }),
    );
    store.execute(
      request({
        type: "message.send",
        conversationId: group.conversationId,
        text: "执行",
        skills: [refs[0]!],
      }),
    );
    const parent = store.runs.claim();
    assert.ok(parent);
    const member = store.runs.nextGroupTurn(parent);
    assert.ok(member);
    assert.ok(member.text.includes("ONLY_" + a));
    assert.ok(!member.text.includes("ONLY_" + b));
    store.execute(
      request({
        type: "skills.select",
        conversationId: group.conversationId,
        references: refs,
        text: "草稿",
      }),
    );
    for (const ref of refs)
      store.execute(request({ type: "skill.delete", ...ref }));
    store.execute(
      request({
        type: "skills.select",
        conversationId: group.conversationId,
        references: [refs[0]!],
        text: "草稿",
      }),
    );
    store.execute(
      request({
        type: "skills.select",
        conversationId: group.conversationId,
        references: [],
        text: "草稿",
      }),
    );
    assert.equal(
      store.views
        .snapshot({ conversationId: group.conversationId })
        .conversations.find((c) => c.id === group.conversationId)?.draftSkills
        .length,
      0,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
