import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Command } from "../src/shared/commands.js";
import {
  applyPendingRestore,
  saveDatabaseBackup,
  scheduleRestore,
} from "../src/storage/backup/backup.js";
import { Store } from "../src/storage/store.js";
const command = (command: Command) => ({
  id: randomUUID(),
  command,
});

await test("restoring fences old work and external authority without modifying the backup or previous database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-restore-fence-"));
  const outside = await mkdtemp(join(tmpdir(), "aster-restore-source-"));
  const live = join(directory, "aster.sqlite"),
    snapshot = join(outside, "snapshot.sqlite");
  try {
    const store = new Store(live);
    try {
      const created = store.execute(
        command({ type: "bot.create", name: "Original", description: "" }),
      );
      assert.ok(created.id && created.conversationId);
      const conversationId = created.conversationId;
      store.execute(
        command({
          type: "message.send",
          conversationId,
          text: "may already have executed",
        }),
      );
      const job = store.runs.claim();
      assert.ok(job);
      store.runs.setThread(job, "external-thread-after-snapshot");
      const legacy = new DatabaseSync(live);
      legacy
        .prepare(
          "INSERT INTO conversation_context(conversationId,botId,threadId,summary,pendingRestart) VALUES(?,?,?,?,1)",
        )
        .run(
          job.conversationId,
          job.botId,
          "external-thread-after-snapshot",
          "historical work; execution remains unconfirmed",
        );
      legacy
        .prepare(
          "INSERT INTO context_checkpoints(conversationId,botId,threadId,summary,tailJson,throughSequence,createdAt) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          job.conversationId,
          job.botId,
          "external-thread-after-snapshot",
          "historical work; execution remains unconfirmed",
          "",
          0,
          Date.now(),
        );
      legacy.close();
      const queued = store.execute(
        command({ type: "conversation.create", botId: created.id }),
      );
      assert.ok(queued.conversationId);
      store.execute(
        command({
          type: "message.send",
          text: "queued before backup",
          conversationId: queued.conversationId,
        }),
      );
      store.execute(
        command({ type: "directory.attach", conversationId, root: outside }),
      );
      const routineId = randomUUID();
      store.execute(
        command({
          type: "routine.save",
          id: routineId,
          botId: created.id,
          revision: 0,
          name: "Webhook",
          prompt: "effect",
          schedule: { kind: "webhook" },
        }),
      );
      // Isolated fixture represents authority that was enabled before the snapshot.
      const fixture = new DatabaseSync(live);
      try {
        fixture
          .prepare("UPDATE routines SET state='active',keyHash=? WHERE id=?")
          .run("a".repeat(64), routineId);
        fixture.exec(
          "UPDATE approval_settings SET enabled=1; UPDATE memory_scopes SET automatic=1;",
        );
      } finally {
        fixture.close();
      }
      await saveDatabaseBackup(directory, snapshot);
    } finally {
      store.close();
    }
    const hash = (data: Uint8Array) =>
      createHash("sha256").update(data).digest("hex");
    const originalHash = hash(await readFile(snapshot));
    scheduleRestore(directory, { kind: "file", path: snapshot });
    const outcome = await applyPendingRestore(directory);
    assert.match(outcome.notice, /已用备份替换/);
    assert.equal(hash(await readFile(snapshot)), originalHash);
    const restored = new Store(live);
    try {
      restored.recover();
      assert.equal(restored.runs.claim(), undefined);
      const db = new DatabaseSync(live, { readOnly: true });
      try {
        assert.equal(
          db.prepare("SELECT count(*) n FROM runs WHERE status='unknown'").get()
            ?.n,
          2,
        );
        assert.equal(
          db.prepare("SELECT threadId FROM conversations").get()?.threadId,
          null,
        );
        assert.equal(
          db.prepare("SELECT count(*) n FROM conversation_context").get()?.n,
          0,
        );
        assert.equal(
          db.prepare("SELECT count(*) n FROM context_checkpoints").get()?.n,
          1,
        );
        assert.equal(
          db.prepare("SELECT count(*) n FROM directory_grants").get()?.n,
          0,
        );
        assert.equal(
          db.prepare("SELECT enabled FROM approval_settings").get()?.enabled,
          0,
        );
        assert.equal(
          db
            .prepare("SELECT count(*) n FROM memory_scopes WHERE automatic=1")
            .get()?.n,
          0,
        );
        const routine = db
          .prepare("SELECT state,keyHash,nextAt FROM routines")
          .get();
        assert.equal(routine?.state, "paused");
        assert.equal(routine?.keyHash, null);
        assert.equal(routine?.nextAt, null);
      } finally {
        db.close();
      }
    } finally {
      restored.close();
    }
    const previous = new DatabaseSync(
      join(directory, "aster.sqlite.previous"),
      {
        readOnly: true,
      },
    );
    try {
      assert.equal(
        previous.prepare("SELECT threadId FROM conversations").get()?.threadId,
        "external-thread-after-snapshot",
      );
      assert.equal(
        previous
          .prepare(
            "SELECT count(*) n FROM runs WHERE status IN ('queued','running')",
          )
          .get()?.n,
        2,
      );
      assert.equal(
        previous.prepare("SELECT count(*) n FROM directory_grants").get()?.n,
        1,
      );
    } finally {
      previous.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
