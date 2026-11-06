import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { questionInputSchema } from "../src/shared/chat/questions.js";
import { Store } from "../src/storage/store.js";

await test("questions preserve drafts, bind answers to their scope, and enqueue exactly once after recovery", () => {
  const store = new Store(":memory:");
  const request = (command: Command) =>
    envelopeSchema.parse({ id: randomUUID(), command });
  const execute = (command: Command) => store.execute(request(command));
  try {
    const bot = execute({
      type: "bot.create",
      name: "Question",
      description: "",
    });
    assert.ok(bot.id && bot.conversationId);
    execute({
      type: "message.send",
      conversationId: bot.conversationId,
      text: "ask",
    });
    const job = store.runs.claim();
    assert.ok(job);
    const input = questionInputSchema.parse({
      prompt: "颜色？",
      options: ["红色", "蓝色"],
    });
    const question = store.toolOperations.questionRequest(job, "q1", input);
    assert.equal(
      store.toolOperations.questionRequest(job, "q1", input).id,
      question.id,
    );
    assert.throws(
      () =>
        store.toolOperations.questionRequest(job, "q1", {
          ...input,
          prompt: "改变",
        }),
      /改变内容/,
    );
    execute({
      type: "draft.save",
      conversationId: job.conversationId,
      text: "ordinary draft",
    });
    const fileId = randomUUID();
    store.files.registerAttachment(
      { id: fileId, conversationId: job.conversationId, name: "draft.txt" },
      Buffer.from("draft attachment"),
    );
    store.runs.finish(job.id, "completed", null);
    store.recover();
    assert.throws(() =>
      execute({
        type: "question.answer",
        id: question.id,
        conversationId: randomUUID(),
        answer: { type: "option", index: 0 },
      }),
    );
    assert.throws(
      () =>
        execute({
          type: "question.answer",
          id: question.id,
          conversationId: job.conversationId,
          answer: { type: "option", index: 5 },
        }),
      /所选答案/,
    );
    const answer = request({
      type: "question.answer",
      id: question.id,
      conversationId: job.conversationId,
      answer: { type: "option", index: 1 },
    });
    const accepted = store.execute(answer);
    assert.ok(accepted.id);
    assert.ok(answer.command.type === "question.answer");
    assert.deepEqual(store.execute(answer), accepted);
    assert.throws(
      () =>
        execute({
          type: "question.answer",
          id: question.id,
          conversationId: job.conversationId,
          answer: { type: "custom", text: "changed" },
        }),
      /已经处理/,
    );
    const snapshot = store.views.snapshot({
      conversationId: job.conversationId,
    });
    assert.equal(snapshot.conversations[0]?.draft, "ordinary draft");
    assert.equal(snapshot.conversations[0]?.draftAttachments[0]?.id, fileId);
    assert.equal(snapshot.runs.filter((r) => r.id === accepted.id).length, 1);
    const answered = snapshot.messages.find(
      (m) => m.question?.id === question.id,
    )?.question;
    assert.equal(answered?.answer, "蓝色");
    assert.equal(answered?.answerRunId, accepted.id);
    assert.equal(snapshot.messages.at(-1)?.replyTo?.id, question.messageId);
    const followup = store.runs.claim();
    assert.ok(followup);
    assert.match(followup.text, /蓝色/);
    const cancelled = store.toolOperations.questionRequest(
      followup,
      "q2",
      input,
    );
    execute({ type: "run.cancel", runId: followup.id });
    assert.throws(
      () => store.toolOperations.questionRequest(followup, "late", input),
      /运行已经结束/,
    );
    assert.throws(
      () =>
        execute({
          type: "question.answer",
          id: cancelled.id,
          conversationId: job.conversationId,
          answer: { type: "option", index: 0 },
        }),
      /已经处理/,
    );
  } finally {
    store.close();
  }
});

await test("questions reject answers from removed group members and skip without starting a run", () => {
  const store = new Store(":memory:");
  const execute = (command: Command) =>
    store.execute(envelopeSchema.parse({ id: randomUUID(), command }));
  try {
    const a = execute({ type: "bot.create", name: "A", description: "" });
    const b = execute({ type: "bot.create", name: "B", description: "" });
    assert.ok(a.id && b.id);
    const group = execute({
      type: "group.start",
      memberIds: [a.id, b.id],
      text: "ask",
    });
    assert.ok(group.conversationId);
    const parent = store.runs.claim();
    assert.ok(parent);
    const job = store.runs.nextGroupTurn(parent);
    assert.ok(job);
    const first = store.toolOperations.questionRequest(job, "q1", {
      prompt: "选择",
      options: ["甲", "乙"],
    });
    const second = store.toolOperations.questionRequest(job, "q2", {
      prompt: "再选择",
      options: ["甲", "乙"],
    });
    store.runs.finish(parent.id, "completed", null);
    const before = store.views.snapshot({ conversationId: job.conversationId })
      .runs.length;
    execute({
      type: "question.answer",
      id: first.id,
      conversationId: job.conversationId,
      answer: { type: "skip" },
    });
    assert.equal(
      store.views.snapshot({ conversationId: job.conversationId }).runs.length,
      before,
    );
    const existing = store.views
      .snapshot({ conversationId: job.conversationId })
      .conversations.find((c) => c.id === job.conversationId)?.group;
    assert.ok(existing);
    execute({
      type: "group.update",
      conversationId: job.conversationId,
      name: "Remaining",
      description: "",
      revision: existing.revision,
      memberIds: existing.memberIds.filter((id) => id !== job.botId),
    });
    assert.throws(
      () =>
        execute({
          type: "question.answer",
          id: second.id,
          conversationId: job.conversationId,
          answer: { type: "custom", text: "answer" },
        }),
      /不在这个会话/,
    );
  } finally {
    store.close();
  }
});

await test("question limits and queue saturation roll back answer consumption before any follow-up runs", () => {
  const store = new Store(":memory:");
  const execute = (command: Command) =>
    store.execute(envelopeSchema.parse({ id: randomUUID(), command }));
  try {
    const bot = execute({
      type: "bot.create",
      name: "Capacity",
      description: "",
    });
    assert.ok(bot.conversationId);
    execute({
      type: "message.send",
      conversationId: bot.conversationId,
      text: "ask",
    });
    const job = store.runs.claim();
    assert.ok(job);
    const questions = Array.from({ length: 4 }, (_, i) =>
      store.toolOperations.questionRequest(job, `q${i}`, {
        prompt: `Question ${i}`,
        options: ["A", "B"],
      }),
    );
    assert.throws(
      () =>
        store.toolOperations.questionRequest(job, "overflow", {
          prompt: "Overflow",
          options: ["A", "B"],
        }),
      /问题过多/,
    );
    store.runs.finish(job.id, "completed", null);
    assert.ok(bot.id);
    let queuedId: string | undefined;
    for (let i = 0; i < 100; i++) {
      const extra = execute({
        type: "conversation.create",
        botId: bot.id,
      }).conversationId;
      assert.ok(extra);
      queuedId = execute({
        type: "message.send",
        conversationId: extra,
        text: `queued ${i}`,
      }).id;
    }
    const question = questions[0];
    assert.ok(question && queuedId);
    const answer = envelopeSchema.parse({
      id: randomUUID(),
      command: {
        type: "question.answer",
        id: question.id,
        conversationId: job.conversationId,
        answer: { type: "custom", text: "real answer" },
      },
    });
    assert.throws(() => store.execute(answer), /队列已满/);
    assert.equal(
      store.views
        .snapshot({ conversationId: job.conversationId })
        .messages.find((message) => message.question?.id === question.id)
        ?.question?.status,
      "pending",
    );
    execute({ type: "run.cancel", runId: queuedId });
    const accepted = store.execute(answer);
    assert.ok(accepted.id);
    assert.deepEqual(store.execute(answer), accepted);
  } finally {
    store.close();
  }
});
