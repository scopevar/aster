import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import {
  templateOperationSchema,
  templateReceiptSchema,
} from "../src/shared/templates/template-tools.js";
import { Store } from "../src/storage/store.js";
import { ToolService } from "../src/tools/service.js";
const envelope = (command: Command) =>
  envelopeSchema.parse({ id: randomUUID(), command });
const create = {
  action: "create",
  name: "聊天模板",
  description: "独立的职责",
  tags: "研究",
  includeSkills: false,
  includeRoutines: false,
} as const;

await test("template cards freeze draft appearance across source edits and restart while legacy receipts remain readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-template-appearance-"));
  const path = join(directory, "db.sqlite");
  let store = new Store(path);
  try {
    const bot = store.execute(
      envelope({ type: "bot.create", name: "A", description: "" }),
    );
    assert.ok(bot.id && bot.conversationId);
    store.execute(
      envelope({
        type: "message.send",
        conversationId: bot.conversationId,
        text: "创建模板",
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    const request = { callId: "original", operation: create };
    const original = store.toolOperations.templateToolRequest(job, request);
    assert.ok(original.action === "create");
    assert.deepEqual(original.receipt.appearance, {
      shape: "hexagon",
      color: "cyan",
    });
    store.execute(
      envelope({
        type: "bot.avatar.character",
        botId: bot.id,
        revision: 0,
        shape: "cloud",
        color: "violet",
      }),
    );
    const draft = store.templateOperations.templateDraft(original.receipt.id);
    store.execute(
      envelope({
        type: "template.save",
        id: draft.id,
        revision: draft.revision,
        payload: {
          ...draft.payload,
          avatar: { shape: "pill", color: "orange", image: null },
        },
      }),
    );
    const changed = store.toolOperations.templateToolRequest(job, {
      callId: "edited",
      operation: {
        action: "update",
        id: draft.id,
        revision: 2,
        name: "新名称",
        description: "",
        tags: "",
      },
    });
    assert.ok(changed.action === "update");
    assert.deepEqual(changed.receipt.appearance, {
      shape: "pill",
      color: "orange",
    });
    store.close();
    store = new Store(path);
    assert.deepEqual(
      store.toolOperations.templateToolRequest(job, request),
      original,
    );
    const cards = store.views.snapshot({
      conversationId: bot.conversationId,
    }).messages;
    assert.deepEqual(
      cards.find((message) => message.id === original.messageId)?.template,
      original.receipt,
    );
    assert.deepEqual(
      cards.find((message) => message.id === changed.messageId)?.template,
      changed.receipt,
    );
    const legacy = { ...original.receipt };
    delete legacy.appearance;
    assert.deepEqual(templateReceiptSchema.parse(legacy), legacy);
    assert.equal(
      templateReceiptSchema.safeParse({
        ...legacy,
        appearance: { shape: "invented", color: "cyan" },
      }).success,
      false,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("template tool transactions preserve chat cards, enforce Bot ownership and revoke cancelled capabilities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-template-tools-")),
    path = join(directory, "db.sqlite");
  let store = new Store(path);
  try {
    const a = store.execute(
      envelope({ type: "bot.create", name: "A", description: "" }),
    );
    const b = store.execute(
      envelope({ type: "bot.create", name: "B", description: "" }),
    );
    assert.ok(a.id && a.conversationId && b.id && b.conversationId);
    store.execute(
      envelope({
        type: "message.send",
        conversationId: a.conversationId,
        text: "创建模板",
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    const input = { callId: "create-1", operation: create };
    const saved = store.toolOperations.templateToolRequest(job, input);
    assert.ok(saved.action === "create");
    const card = store.views
      .snapshot({ conversationId: a.conversationId })
      .messages.find((m) => m.id === saved.messageId);
    assert.deepEqual(card?.template, saved.receipt);
    assert.equal(
      store.templateOperations.templateDraft(saved.receipt.id).revision,
      saved.receipt.revision,
    );
    store.close();
    store = new Store(path);
    assert.deepEqual(
      store.toolOperations.templateToolRequest(job, input),
      saved,
    );
    assert.throws(
      () =>
        store.toolOperations.templateToolRequest(job, {
          ...input,
          operation: { ...create, name: "changed" },
        }),
      /改变参数/,
    );
    store.execute(
      envelope({
        type: "message.send",
        conversationId: b.conversationId,
        text: "查询模板",
      }),
    );
    const other = store.runs.claim();
    assert.ok(other);
    assert.deepEqual(
      store.toolOperations.templateToolRequest(other, {
        callId: "list",
        operation: { action: "list" },
      }),
      { action: "list", drafts: [] },
    );
    assert.throws(
      () =>
        store.toolOperations.templateToolRequest(other, {
          callId: "read",
          operation: { action: "read", id: saved.receipt.id },
        }),
      /不属于/,
    );
    const update = {
      action: "update",
      id: saved.receipt.id,
      revision: 1,
      name: "更新模板",
      description: "新职责",
      tags: "",
    };
    const changed = store.toolOperations.templateToolRequest(job, {
      callId: "update",
      operation: update,
    });
    assert.ok(changed.action === "update");
    assert.equal(changed.receipt.revision, 2);
    assert.throws(
      () =>
        store.toolOperations.templateToolRequest(job, {
          callId: "stale",
          operation: update,
        }),
      /已改变/,
    );
    assert.equal(
      templateOperationSchema.safeParse({
        action: "publish",
        id: saved.receipt.id,
      }).success,
      false,
    );
    const fault = new DatabaseSync(path);
    try {
      fault.exec(
        "CREATE TRIGGER fail_template_call BEFORE INSERT ON template_tool_calls BEGIN SELECT RAISE(ABORT,'injected call receipt failure'); END;",
      );
      const drafts = store.templateOperations.localTemplates().drafts.length;
      const messages = store.views.snapshot({
        conversationId: a.conversationId,
      }).messages.length;
      assert.throws(
        () =>
          store.toolOperations.templateToolRequest(job, {
            callId: "rollback",
            operation: create,
          }),
        /injected call receipt failure/,
      );
      assert.equal(
        store.templateOperations.localTemplates().drafts.length,
        drafts,
      );
      assert.equal(
        store.views.snapshot({ conversationId: a.conversationId }).messages
          .length,
        messages,
      );
      fault.exec("DROP TRIGGER fail_template_call");
    } finally {
      fault.close();
    }
    const controller = new AbortController();
    const tools = new ToolService(store, 39999);
    const scope = tools.open(job, controller.signal);
    controller.abort();
    assert.throws(
      () =>
        tools.templates(
          scope.connection.token,
          { callId: "late", operation: create },
          new AbortController().signal,
        ),
      /授权已结束/,
    );
    await scope.close();
    store.execute(
      envelope({ type: "template.delete", id: saved.receipt.id, revision: 2 }),
    );
    assert.equal(
      store.views
        .snapshot({ conversationId: a.conversationId })
        .messages.find((m) => m.id === saved.messageId)?.template?.name,
      "聊天模板",
    );
    store.recover();
    assert.throws(
      () =>
        store.toolOperations.templateToolRequest(job, {
          callId: "after-crash",
          operation: create,
        }),
      /运行已结束/,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("template tools reject group and automated runs without draft or message side effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-template-scope-"));
  const store = new Store(join(directory, "db.sqlite"));
  try {
    const bot = store.execute(
      envelope({ type: "bot.create", name: "A", description: "" }),
    );
    const other = store.execute(
      envelope({ type: "bot.create", name: "B", description: "" }),
    );
    assert.ok(bot.id && other.id);
    const group = store.execute(
      envelope({
        type: "group.start",
        memberIds: [bot.id, other.id],
        text: "讨论",
      }),
    );
    assert.ok(group.conversationId);
    const parent = store.runs.claim();
    assert.ok(parent);
    const member = store.runs.nextGroupTurn(parent);
    assert.ok(member);
    const groupMessages = store.views.snapshot({
      conversationId: group.conversationId,
    }).messages.length;
    assert.throws(
      () =>
        store.toolOperations.templateToolRequest(member, {
          callId: "group",
          operation: create,
        }),
      /仅供用户发起/,
    );
    assert.equal(store.templateOperations.localTemplates().drafts.length, 0);
    assert.equal(
      store.views.snapshot({ conversationId: group.conversationId }).messages
        .length,
      groupMessages,
    );
    store.execute(envelope({ type: "run.cancel", runId: parent.id }));
    store.runs.finishGroupTurn(member, "cancelled", null);
    store.runs.finish(parent.id, "cancelled", null);
    const routineId = randomUUID();
    store.execute(
      envelope({
        type: "routine.save",
        id: routineId,
        botId: bot.id,
        revision: 0,
        name: "自动任务",
        prompt: "创建模板",
        schedule: { kind: "webhook" },
      }),
    );
    store.execute(
      envelope({
        type: "routine.test",
        id: routineId,
        botId: bot.id,
        revision: 1,
      }),
    );
    const automatic = store.runs.claim();
    assert.ok(automatic);
    const messages = store.views.snapshot({
      conversationId: automatic.conversationId,
    }).messages.length;
    for (const operation of [create, { action: "list" }])
      assert.throws(
        () =>
          store.toolOperations.templateToolRequest(automatic, {
            callId: "automated",
            operation,
          }),
        /仅供用户发起/,
      );
    assert.equal(store.templateOperations.localTemplates().drafts.length, 0);
    assert.equal(
      store.views.snapshot({ conversationId: automatic.conversationId })
        .messages.length,
      messages,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
