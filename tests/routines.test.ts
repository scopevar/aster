import { maxDatabaseVersion } from "../src/shared/backup.js";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  nextRoutineTime,
  routineFollowUpTime,
  routineStartTime,
} from "../src/routines/schedule.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import type { RoutineSchedule } from "../src/shared/routines.js";
import { Store } from "../src/storage/store.js";
import type { Job } from "../src/storage/job.js";
import { ToolService } from "../src/tools/service.js";

const command = (value: Command) =>
  envelopeSchema.parse({ id: randomUUID(), command: value });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "aster-routine-"));
  const path = join(dir, "db.sqlite");
  const store = new Store(path);
  const bot = store.execute(
    command({ type: "bot.create", name: "Scheduled", description: "" }),
  );
  assert.ok(bot.id && bot.conversationId);
  const botId = bot.id,
    conversationId = bot.conversationId;
  const save = (
    schedule: RoutineSchedule = {
      kind: "cron",
      expression: "* * * * *",
      timeZone: "Asia/Shanghai",
    },
    enabled = true,
  ) => {
    const id = randomUUID();
    store.execute(
      command({
        type: "routine.save",
        id,
        botId,
        revision: 0,
        name: "Daily",
        prompt: "Test instructions",
        schedule,
        enabled,
      }),
    );
    return id;
  };
  return {
    store,
    path,
    botId,
    conversationId,
    save,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

await test("routine tools persist visible receipts atomically, deduplicate calls and revoke access on cancellation", async () => {
  const f = fixture();
  const tools = new ToolService(f.store, 39999);
  const controller = new AbortController();
  try {
    f.store.execute(
      command({
        type: "message.send",
        conversationId: f.conversationId,
        text: "创建例行任务",
      }),
    );
    const job = f.store.runs.claim();
    assert.ok(job);
    const scope = tools.open(job, controller.signal);
    const request = {
      callId: "create",
      operation: {
        action: "create",
        name: "每日任务",
        prompt: "总结当前日期",
        schedule: {
          kind: "cron",
          expression: "0 9 * * *",
          timeZone: "Asia/Shanghai",
        },
      },
    };
    const saved = tools.routines(
      scope.connection.token,
      request,
      new AbortController().signal,
    );
    assert.equal(saved.action, "create");
    assert.ok(saved.action === "create");
    assert.equal(saved.routine.state, "active");
    assert.deepEqual(
      tools.routines(
        scope.connection.token,
        request,
        new AbortController().signal,
      ),
      saved,
    );
    assert.equal(
      f.store.routineOperations.view({ botId: f.botId }).routines.length,
      1,
    );
    const receipt = f.store.views
      .snapshot({ conversationId: f.conversationId })
      .messages.find((m) => m.id === saved.messageId);
    assert.equal(receipt?.routine?.routine.id, saved.routine.id);
    assert.throws(
      () =>
        tools.routines(
          scope.connection.token,
          {
            ...request,
            operation: { ...request.operation, prompt: "changed" },
          },
          new AbortController().signal,
        ),
      /改变参数/,
    );
    f.store.execute(
      command({
        type: "routine.state",
        id: saved.routine.id,
        botId: f.botId,
        revision: 1,
        state: "active",
      }),
    );
    const updated = tools.routines(
      scope.connection.token,
      {
        callId: "edit",
        operation: {
          ...request.operation,
          action: "update",
          id: saved.routine.id,
          revision: 2,
          prompt: "new instructions",
        },
      },
      new AbortController().signal,
    );
    assert.ok(updated.action === "update");
    assert.equal(updated.routine.state, "active");
    assert.equal(updated.routine.revision, 3);
    const other = f.store.execute(
      command({ type: "bot.create", name: "other", description: "" }),
    ).id;
    assert.ok(other);
    const otherRoutine = randomUUID();
    f.store.execute(
      command({
        type: "routine.save",
        id: otherRoutine,
        botId: other,
        revision: 0,
        name: "secret",
        prompt: "private",
        schedule: { kind: "webhook" },
      }),
    );
    assert.throws(
      () =>
        tools.routines(
          scope.connection.token,
          {
            callId: "read-other",
            operation: { action: "read", id: otherRoutine },
          },
          new AbortController().signal,
        ),
      /不属于/,
    );
    const db = new DatabaseSync(f.path);
    try {
      db.exec(
        "CREATE TRIGGER fail_receipt BEFORE INSERT ON routine_tool_calls BEGIN SELECT RAISE(ABORT,'receipt commit failed'); END",
      );
      assert.throws(
        () =>
          tools.routines(
            scope.connection.token,
            { ...request, callId: "rollback" },
            new AbortController().signal,
          ),
        /commit failed/,
      );
      assert.equal(
        f.store.routineOperations.view({ botId: f.botId }).routines.length,
        1,
      );
      assert.equal(
        f.store.views
          .snapshot({ conversationId: f.conversationId })
          .messages.filter((m) => m.routine).length,
        2,
      );
      db.exec("DROP TRIGGER fail_receipt");
    } finally {
      db.close();
    }
    controller.abort();
    assert.throws(
      () =>
        tools.routines(
          scope.connection.token,
          request,
          new AbortController().signal,
        ),
      /授权已结束/,
    );
    await scope.close();
    f.store.runs.finish(job.id, "cancelled", null);
    assert.throws(
      () => f.store.toolOperations.routineToolRequest(job, request),
      /运行已结束/,
    );
    f.store.execute(
      command({
        type: "routine.test",
        id: saved.routine.id,
        botId: f.botId,
        revision: 3,
      }),
    );
    const automatic = f.store.runs.claim();
    assert.ok(automatic);
    assert.throws(
      () =>
        f.store.toolOperations.routineToolRequest(automatic, {
          callId: "recursive",
          operation: { action: "list" },
        }),
      /自动运行/,
    );
  } finally {
    controller.abort();
    f.close();
  }
});

await test("cron uses fixed IANA zones, DST and restart-safe UTC cursors; invalid schedules fail", () => {
  const next = (expression: string, timeZone: string, after: string) =>
    new Date(
      nextRoutineTime(
        { kind: "cron", expression, timeZone },
        Date.parse(after),
      ) ?? 0,
    ).toISOString();
  assert.equal(
    next("0 9 * * 1-5", "Asia/Shanghai", "2026-09-25T02:00:00Z"),
    "2026-09-28T01:00:00.000Z",
  );
  assert.equal(
    next("30 2 * * *", "America/New_York", "2026-03-08T05:00:00Z"),
    "2026-03-08T07:30:00.000Z",
  );
  const autumn = next("30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z");
  assert.equal(autumn, "2026-11-01T05:30:00.000Z");
  assert.equal(
    next("30 1 * * *", "America/New_York", autumn),
    "2026-11-02T06:30:00.000Z",
  );
  assert.equal(
    next("0 0 29 2 *", "UTC", "2026-01-01T00:00:00Z"),
    "2028-02-29T00:00:00.000Z",
  );
  for (const expression of ["* * * * * *", "H * * * *", "0 0 30 2 *", "wrong"])
    assert.throws(
      () => next(expression, "UTC", "2026-01-01T00:00:00Z"),
      /五段/,
    );
  assert.throws(
    () => next("0 9 * * *", "Not/AZone", "2026-01-01T00:00:00Z"),
    /时区/,
  );
  const at = "2026-10-18T09:00:00+08:00",
    atMs = Date.parse(at);
  assert.equal(
    nextRoutineTime({ kind: "at", at }, Date.parse("2026-10-17T00:00:00Z")),
    atMs,
  );
  assert.equal(
    routineStartTime({ kind: "at", at }, Date.parse("2026-10-19T00:00:00Z")),
    atMs,
  );
  assert.equal(
    routineFollowUpTime({ kind: "at", at }, Date.parse("2026-10-19T00:00:00Z")),
    null,
  );
  assert.throws(
    () => nextRoutineTime({ kind: "at", at }, atMs),
    /晚于当前时间/,
  );
});

await test("new routines default active and relative delay is resolved exactly once", (t) => {
  const f = fixture();
  const now = Date.parse("2026-10-19T07:48:49Z");
  t.mock.method(Date, "now", () => now);
  try {
    const id = randomUUID();
    f.store.execute(
      command({
        type: "routine.save",
        id,
        botId: f.botId,
        revision: 0,
        name: "Reminder",
        prompt: "Send the reminder",
        schedule: { kind: "delay", seconds: 180 },
      }),
    );
    const routine = f.store.routineOperations
      .view({ botId: f.botId, routineId: id })
      .routines.find((item) => item.id === id);
    assert.equal(routine?.state, "active");
    assert.equal(routine?.nextAt, now + 180000);
    assert.deepEqual(routine?.schedule, {
      kind: "at",
      at: new Date(now + 180000).toISOString(),
    });
    assert.equal(f.store.routineOperations.tick(now + 179000), 0);
    assert.equal(f.store.routineOperations.tick(now + 180000), 1);
    const event = f.store.routineOperations.view({
      botId: f.botId,
      routineId: id,
    }).events[0];
    assert.ok(event?.runId);
    assert.equal(event.scheduledAt, now + 180000);
    assert.throws(
      () =>
        f.store.execute(
          command({
            type: "routine.save",
            id: randomUUID(),
            botId: f.botId,
            revision: 0,
            name: "Past",
            prompt: "Must not be created",
            schedule: {
              kind: "at",
              at: "2026-10-19T07:51:49+08:00",
            },
          }),
        ),
      /晚于当前时间/,
    );
  } finally {
    f.close();
  }
});

await test("routines atomically coalesce missed times, deduplicate tests, preserve drafts and isolate threads", (t) => {
  const f = fixture();
  let now = Date.parse("2026-09-25T00:00:10Z");
  t.mock.method(Date, "now", () => now);
  try {
    f.store.execute(
      command({
        type: "draft.save",
        conversationId: f.conversationId,
        text: "private unsent draft",
      }),
    );
    const id = f.save(undefined, false);
    assert.equal(f.store.routineOperations.tick(now + 600000), 0);
    f.store.execute(
      command({
        type: "routine.state",
        id,
        botId: f.botId,
        revision: 1,
        state: "active",
      }),
    );
    const due = f.store.routineOperations.view({ botId: f.botId }).routines[0]
      ?.nextAt;
    assert.equal(due, Date.parse("2026-09-25T00:01:00Z"));
    now += 3600000;
    assert.equal(f.store.routineOperations.tick(now), 1);
    assert.equal(f.store.routineOperations.tick(now), 0);
    const query = { botId: f.botId, routineId: id };
    const event = f.store.routineOperations.view(query).events[0];
    assert.ok(event?.runId && event.conversationId);
    assert.equal(event.scheduledAt, due);
    assert.equal(event.coveredUntil, now);
    assert.notEqual(event.conversationId, f.conversationId);
    assert.equal(
      f.store.views
        .snapshot({ conversationId: f.conversationId })
        .conversations.find((c) => c.id === f.conversationId)?.draft,
      "private unsent draft",
    );
    const test = command({
      type: "routine.test",
      id,
      botId: f.botId,
      revision: 2,
    });
    assert.deepEqual(f.store.execute(test), f.store.execute(test));
    assert.equal(f.store.routineOperations.view(query).events.length, 2);
    assert.equal(
      f.store.routineOperations.view(query).events[0]?.status,
      "skipped",
    );
    f.store.execute(
      command({
        type: "routine.state",
        id,
        botId: f.botId,
        revision: 2,
        state: "paused",
      }),
    );
    assert.equal(f.store.runs.getRun(event.runId)?.status, "queued");
    const job = f.store.runs.claim();
    assert.ok(job);
    f.store.runs.setThread(job, "isolated-thread");
    f.store.runs.finish(job.id, "completed", null);
    f.store.execute(
      command({ type: "routine.test", id, botId: f.botId, revision: 3 }),
    );
    const nextJob = f.store.runs.claim();
    assert.ok(nextJob);
    assert.equal(nextJob.threadId, null);
    f.store.recover();
    assert.equal(
      f.store.routineOperations.view(query).events[0]?.status,
      "unknown",
    );
    assert.equal(f.store.runs.claim(), undefined);
    assert.equal(f.store.routineOperations.tick(now + 100000), 0);
  } finally {
    f.close();
  }
});

await test("failed trigger transaction leaves neither a run nor an advanced cursor", (t) => {
  const f = fixture();
  const now = Date.parse("2026-09-25T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  const db = new DatabaseSync(f.path);
  try {
    const id = f.save();
    f.store.execute(
      command({
        type: "routine.state",
        id,
        botId: f.botId,
        revision: 1,
        state: "active",
      }),
    );
    const due = f.store.routineOperations.view({ botId: f.botId }).routines[0]
      ?.nextAt;
    assert.ok(due);
    const conversations = f.store.views.snapshot({}).conversations.length;
    db.exec(
      "CREATE TRIGGER fail_routine BEFORE INSERT ON routine_events BEGIN SELECT RAISE(ABORT,'injected disk commit failure'); END",
    );
    assert.throws(() => f.store.routineOperations.tick(due), /injected/);
    assert.equal(
      f.store.routineOperations.view({ botId: f.botId }).routines[0]?.nextAt,
      due,
    );
    assert.equal(
      f.store.views.snapshot({}).conversations.length,
      conversations,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM runs").get()?.n, 0);
    db.exec("DROP TRIGGER fail_routine");
    assert.equal(f.store.routineOperations.tick(due), 1);
    assert.equal(
      db.prepare("PRAGMA user_version").get()?.user_version,
      maxDatabaseVersion,
    );
    assert.equal(db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    f.close();
  }
});

await test("webhooks verify scope, timestamp, replay, overlap, rotation, revocation and deletion", () => {
  const f = fixture();
  try {
    const id = f.save({ kind: "webhook" });
    const token = randomBytes(32).toString("hex"),
      hash = createHash("sha256").update(token).digest("hex");
    const target = { id, botId: f.botId };
    assert.throws(
      () =>
        f.store.execute(
          command({
            type: "routine.state",
            ...target,
            revision: 1,
            state: "active",
          }),
        ),
      /密钥/,
    );
    f.store.execute(
      command({ type: "routine.key", ...target, revision: 1, hash }),
    );
    f.store.execute(
      command({
        type: "routine.state",
        ...target,
        revision: 2,
        state: "active",
      }),
    );
    const input = {
      eventId: "event-1",
      timestamp: Date.now(),
      text: "external payload",
    };
    assert.throws(
      () => f.store.routineOperations.acceptWebhook(id, "bad", input),
      /认证/,
    );
    assert.throws(
      () =>
        f.store.routineOperations.acceptWebhook(id, token, {
          ...input,
          timestamp: Date.now() - 300001,
        }),
      /时间戳/,
    );
    const event = f.store.routineOperations.acceptWebhook(id, token, input);
    assert.equal(event.status, "queued");
    assert.equal(
      f.store.routineOperations.acceptWebhook(id, token, input).id,
      event.id,
    );
    assert.throws(
      () =>
        f.store.routineOperations.acceptWebhook(id, token, {
          ...input,
          text: "changed",
        }),
      /编号/,
    );
    assert.equal(
      f.store.routineOperations.acceptWebhook(id, token, {
        ...input,
        eventId: "event-2",
      }).status,
      "queued",
    );
    assert.equal(
      f.store.routineOperations.webhookEvent(id, token, event.id).id,
      event.id,
    );
    f.store.execute(
      command({
        type: "routine.key",
        ...target,
        revision: 3,
        hash: createHash("sha256").update("replacement").digest("hex"),
      }),
    );
    assert.throws(
      () => f.store.routineOperations.acceptWebhook(id, token, input),
      /认证/,
    );
    assert.throws(
      () => f.store.routineOperations.webhookEvent(id, token, event.id),
      /认证/,
    );
    const other = f.store.execute(
      command({ type: "bot.create", name: "other", description: "" }),
    ).id;
    assert.ok(other);
    assert.throws(
      () => f.store.routineOperations.view({ botId: other, routineId: id }),
      /不属于/,
    );
    assert.throws(
      () =>
        f.store.execute(
          command({
            type: "routine.test",
            ...target,
            botId: other,
            revision: 4,
          }),
        ),
      /不属于/,
    );
    f.store.execute(
      command({
        type: "routine.state",
        ...target,
        revision: 4,
        state: "deleted",
      }),
    );
    assert.equal(
      f.store.routineOperations
        .view({ botId: f.botId, routineId: id })
        .events.find((e) => e.id === event.id)?.status,
      "cancelled",
    );
    assert.throws(
      () =>
        f.store.execute(
          command({ type: "routine.test", ...target, revision: 5 }),
        ),
      /删除/,
    );
    assert.equal(
      JSON.stringify(
        f.store.routineOperations.view({ botId: f.botId }),
      ).includes(hash),
      false,
    );
  } finally {
    f.close();
  }
});

await test("queue capacity and webhook rate limits are enforced server-side, history is paginated", () => {
  const f = fixture();
  try {
    const id = f.save({ kind: "webhook" }),
      token = randomBytes(32).toString("hex");
    f.store.execute(
      command({
        type: "routine.key",
        id,
        botId: f.botId,
        revision: 1,
        hash: createHash("sha256").update(token).digest("hex"),
      }),
    );
    f.store.execute(
      command({
        type: "routine.state",
        id,
        botId: f.botId,
        revision: 2,
        state: "active",
      }),
    );
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      const at = now + Math.floor(i / 30) * 60001;
      f.store.routineOperations.acceptWebhook(
        id,
        token,
        { eventId: String(i), timestamp: at, text: "" },
        at,
      );
    }
    assert.throws(
      () =>
        f.store.routineOperations.acceptWebhook(
          id,
          token,
          { eventId: "overflow", timestamp: now + 60001, text: "" },
          now + 60001,
        ),
      /30/,
    );
    const query = { botId: f.botId, routineId: id };
    const first = f.store.routineOperations.view(query);
    assert.equal(first.events.length, 50);
    assert.equal(first.hasOlder, true);
    const second = f.store.routineOperations.view({
      ...query,
      before: first.events.at(-1)?.sequence,
    });
    assert.equal(second.events.length, 10);
    assert.equal(second.hasOlder, false);
    assert.equal(
      new Set([...first.events, ...second.events].map((e) => e.id)).size,
      60,
    );
    for (let i = 0; i < 99; i++) {
      const extra = f.store.execute(
        command({ type: "conversation.create", botId: f.botId }),
      ).conversationId;
      assert.ok(extra);
      f.store.execute(
        command({
          type: "message.send",
          conversationId: extra,
          text: String(i),
        }),
      );
    }
    const extra = f.save();
    f.store.execute(
      command({ type: "routine.test", id: extra, botId: f.botId, revision: 1 }),
    );
    assert.match(
      f.store.routineOperations.view({ botId: f.botId, routineId: extra })
        .events[0]?.error ?? "",
      /队列已满/,
    );
  } finally {
    f.close();
  }
});

await test("one-time routines queue once, stay hidden, notify visibly and retire only after scheduled success", (t) => {
  const f = fixture();
  const now = Date.parse("2026-09-25T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  try {
    const scheduleAt = (at: number): RoutineSchedule => ({
      kind: "at",
      at: new Date(at).toISOString(),
    });
    const saveAt = (at: number, name = "One shot") => {
      const id = randomUUID();
      f.store.execute(
        command({
          type: "routine.save",
          id,
          botId: f.botId,
          revision: 0,
          name,
          prompt: "Check the target.",
          schedule: scheduleAt(at),
          enabled: false,
        }),
      );
      return id;
    };
    assert.throws(() => saveAt(now - 1000), /晚于当前时间/);
    const id = saveAt(now + 600000);
    const initial = f.store.routineOperations.view({
      botId: f.botId,
      routineId: id,
    });
    assert.equal(initial.routines[0]?.state, "paused");
    assert.equal(initial.routines[0]?.nextAt, null);
    assert.equal(f.store.routineOperations.tick(now + 900000), 0);
    f.store.execute(
      command({
        type: "routine.state",
        id,
        botId: f.botId,
        revision: 1,
        state: "active",
      }),
    );
    const at = now + 600000;
    const enabled = f.store.routineOperations.view({
      botId: f.botId,
      routineId: id,
    });
    assert.equal(enabled.routines[0]?.nextAt, at);
    const summaryJob: Job = {
      id: randomUUID(),
      botId: f.botId,
      conversationId: f.conversationId,
      text: "",
      threadId: null,
      description: "",
      attachments: [],
    };
    const summary = f.store.routineOperations.routineContext(summaryJob);
    assert.match(summary, /One shot/);
    assert.match(summary, /已启用/);
    assert.match(summary, /一次性/);
    assert.equal(f.store.routineOperations.tick(at), 1);
    const event = f.store.routineOperations.view({
      botId: f.botId,
      routineId: id,
    }).events[0];
    assert.equal(event?.status, "queued");
    const conversation = f.store.views
      .snapshot({})
      .conversations.find((item) => item.id === event?.conversationId);
    assert.equal(conversation?.hidden, true);
    const job = f.store.runs.claim();
    assert.ok(job);
    assert.equal(f.store.routineOperations.routineContext(job), "");
    const notice = f.store.toolOperations.notificationRequest(job, {
      callId: "notice-1",
      text: "发现变化",
    });
    assert.equal(notice.status, "sent");
    assert.notEqual(notice.conversationId, job.conversationId);
    const visible = f.store.views.snapshot({
      conversationId: notice.conversationId,
    });
    assert.equal(
      visible.messages.find((message) => message.id === notice.messageId)?.text,
      "发现变化",
    );
    assert.deepEqual(
      f.store.toolOperations.notificationRequest(job, {
        callId: "notice-1",
        text: "发现变化",
      }),
      notice,
    );
    const call = f.store.pluginCalls.create(job, "approval-1", "Mail", {
      action: "call",
      pluginId: randomUUID(),
      server: "mail",
      tool: "send",
      arguments: { to: "user@example.com", body: "hello" },
    });
    const card = f.store.views
      .snapshot({ conversationId: notice.conversationId })
      .messages.find((message) => message.pluginCall?.id === call.id);
    assert.equal(card?.pluginCall?.arguments.to, "user@example.com");
    f.store.runs.finish(job.id, "completed", null);
    const retired = f.store.routineOperations.view({
      botId: f.botId,
      routineId: id,
    });
    assert.equal(retired.routines[0]?.state, "deleted");
    assert.equal(retired.routines[0]?.nextAt, null);
    assert.equal(f.store.routineOperations.tick(at + 100000), 0);
    const failId = saveAt(at + 1200000, "Failing once");
    f.store.execute(
      command({
        type: "routine.state",
        id: failId,
        botId: f.botId,
        revision: 1,
        state: "active",
      }),
    );
    assert.equal(f.store.routineOperations.tick(at + 1200000), 1);
    const failedJob = f.store.runs.claim();
    assert.ok(failedJob);
    f.store.runs.finish(failedJob.id, "failed", "provider failed");
    const failed = f.store.routineOperations.view({
      botId: f.botId,
      routineId: failId,
    });
    const failedRoutine = failed.routines.find((item) => item.id === failId);
    assert.equal(failedRoutine?.state, "active");
    assert.equal(failedRoutine?.nextAt, null);
    assert.match(failedRoutine?.error ?? "", /未成功/);
    assert.equal(f.store.routineOperations.tick(at + 2000000), 0);
  } finally {
    f.close();
  }
});

await test("routine tool replay precedes the per-turn quota and a rejected change rolls back its receipt and definition", () => {
  const f = fixture();
  const db = new DatabaseSync(f.path);
  try {
    f.store.execute(
      command({
        type: "message.send",
        conversationId: f.conversationId,
        text: "manage tasks",
      }),
    );
    const job = f.store.runs.claim();
    assert.ok(job);
    const request = { callId: "list-0", operation: { action: "list" } };
    const first = f.store.toolOperations.routineToolRequest(job, request);
    for (let index = 1; index < 24; index++)
      f.store.toolOperations.routineToolRequest(job, {
        ...request,
        callId: `list-${index}`,
      });
    assert.deepEqual(
      f.store.toolOperations.routineToolRequest(job, request),
      first,
    );
    const before = f.store.cursor();
    assert.throws(
      () =>
        f.store.toolOperations.routineToolRequest(job, {
          ...request,
          callId: "list-24",
        }),
      /24/,
    );
    assert.deepEqual(f.store.cursor(), before);
    assert.throws(
      () =>
        f.store.toolOperations.routineToolRequest(job, {
          callId: "list-0",
          operation: {
            action: "create",
            name: "changed",
            prompt: "x",
            schedule: { kind: "webhook" },
          },
        }),
      /不能改变参数/,
    );
    // The audit budget accounts for existing durable bytes before committing a new definition.
    db.prepare("DELETE FROM routine_tool_calls WHERE runId=?").run(job.id);
    db.prepare(
      "INSERT INTO routine_tool_calls(runId,callId,fingerprint,resultJson) VALUES(?,?,?,json_object('padding',printf('%.*c',?,'x')))",
    ).run(job.id, "audit-fixture", "f".repeat(64), 64 * 1024 * 1024);
    assert.throws(
      () =>
        f.store.toolOperations.routineToolRequest(job, {
          callId: "over-budget",
          operation: {
            action: "create",
            name: "uncommitted",
            prompt: "x",
            schedule: { kind: "webhook" },
          },
        }),
      /64 MiB/,
    );
    assert.equal(
      f.store.routineOperations.view({ botId: f.botId }).routines.length,
      0,
    );
    assert.equal(
      f.store.views
        .snapshot({ conversationId: f.conversationId })
        .messages.filter((m) => m.routine).length,
      0,
    );
    assert.deepEqual(f.store.cursor(), before);
  } finally {
    db.close();
    f.close();
  }
});
