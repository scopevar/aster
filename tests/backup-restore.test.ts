import { maxDatabaseVersion } from "../src/shared/backup.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AppError } from "../src/shared/core.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import {
  applyPendingRestore,
  readBackupStatus,
  saveDatabaseBackup,
  scheduleRestore,
} from "../src/storage/backup/backup.js";
import { Store } from "../src/storage/store.js";
import { legacyDatabase } from "./helpers/legacy-database.js";

function command(command: Command) {
  return envelopeSchema.parse({ id: randomUUID(), command });
}

await test("a scheduled restore replaces the chat database and keeps the previous file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-restore-"));
  const outside = await mkdtemp(join(tmpdir(), "aster-restore-out-"));
  try {
    const store = new Store(join(directory, "aster.sqlite"));
    const created = store.execute(
      command({ type: "bot.create", name: "备份前", description: "" }),
    );
    const conversationId = created.conversationId;
    assert.ok(conversationId);
    const bytes = Buffer.from("attachment-kept");
    const attachment = store.files.registerAttachment(
      { id: randomUUID(), conversationId, name: "note.txt" },
      bytes,
    );
    const snapshot = join(outside, "chat.sqlite");
    assert.equal(await saveDatabaseBackup(directory, snapshot), "chat.sqlite");
    store.execute(
      command({ type: "bot.create", name: "备份后", description: "" }),
    );
    store.close();
    const scheduled = scheduleRestore(directory, {
      kind: "file",
      path: snapshot,
    });
    assert.equal(scheduled.pending, true);
    assert.equal(scheduled.pendingLabel, "chat.sqlite");
    const applied = await applyPendingRestore(directory);
    assert.equal(applied.pending, false);
    assert.equal(applied.previousAvailable, true);
    assert.match(applied.notice, /已用备份替换/);
    const restored = new Store(join(directory, "aster.sqlite"));
    try {
      const names = restored.views.snapshot({}).bots.map((bot) => bot.name);
      assert.deepEqual(names, ["备份前"]);
      const kept = restored.files.attachmentContent(
        conversationId,
        attachment.id,
      );
      assert.ok(Buffer.from(kept.bytes).equals(bytes));
    } finally {
      restored.close();
    }
    const previous = new Store(join(directory, "aster.sqlite.previous"));
    try {
      assert.deepEqual(
        previous.views
          .snapshot({})
          .bots.map((bot) => bot.name)
          .sort(),
        ["备份前", "备份后"],
      );
    } finally {
      previous.close();
    }
    scheduleRestore(directory, { kind: "previous" });
    await applyPendingRestore(directory);
    const undone = new Store(join(directory, "aster.sqlite"));
    try {
      assert.deepEqual(
        undone.views
          .snapshot({})
          .bots.map((bot) => bot.name)
          .sort(),
        ["备份前", "备份后"],
      );
    } finally {
      undone.close();
    }
    assert.equal(existsSync(join(directory, "pending-restore.json")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

await test("a bad or protected restore request leaves the open database unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-restore-reject-"));
  const outside = await mkdtemp(join(tmpdir(), "aster-restore-reject-out-"));
  try {
    const store = new Store(join(directory, "aster.sqlite"));
    store.execute(
      command({ type: "bot.create", name: "仍在", description: "" }),
    );
    store.close();
    await assert.rejects(
      saveDatabaseBackup(directory, join(directory, "inside.sqlite")),
      (error: unknown) =>
        error instanceof AppError && error.code === "invalid_input",
    );
    assert.throws(
      () =>
        scheduleRestore(
          directory,
          {
            kind: "file",
            path: join(directory, "installed", "aster.sqlite"),
          },
          join(directory, "installed"),
        ),
      (error: unknown) =>
        error instanceof AppError && error.code === "unauthorized",
    );
    const junk = join(outside, "notes.txt");
    await writeFile(junk, "not a database");
    assert.throws(
      () => scheduleRestore(directory, { kind: "file", path: junk }),
      (error: unknown) => error instanceof AppError,
    );
    const snapshot = join(outside, "too-new.sqlite");
    await saveDatabaseBackup(directory, snapshot);
    const raised = new DatabaseSync(snapshot);
    raised.exec(`PRAGMA user_version=${maxDatabaseVersion + 1}`);
    raised.close();
    assert.throws(
      () => scheduleRestore(directory, { kind: "file", path: snapshot }),
      (error: unknown) =>
        error instanceof AppError && /高于当前应用/.test(error.message),
    );
    const older = new DatabaseSync(snapshot);
    older.exec("PRAGMA user_version=1");
    older.close();
    assert.throws(
      () => scheduleRestore(directory, { kind: "file", path: snapshot }),
      (error: unknown) =>
        error instanceof AppError && /版本/.test(error.message),
    );
    await writeFile(
      join(directory, "pending-restore.json"),
      JSON.stringify({
        version: 1,
        source: { kind: "file", path: junk },
      }),
    );
    const failed = await applyPendingRestore(directory);
    assert.equal(failed.pending, false);
    assert.match(
      failed.notice,
      /未替换|无法读取|不是本应用|无法读取这份备份|必须是普通/,
    );
    const kept = new Store(join(directory, "aster.sqlite"));
    try {
      assert.deepEqual(
        kept.views.snapshot({}).bots.map((bot) => bot.name),
        ["仍在"],
      );
    } finally {
      kept.close();
    }
    assert.equal(readBackupStatus(directory).pending, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

for (const version of [9, 24, 32] as const) {
  await test(`restoring a v${version} backup upgrades only its staged copy and retains the replaced database`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "aster-restore-legacy-"));
    const outside = await mkdtemp(join(tmpdir(), "aster-restore-legacy-out-"));
    const source = join(outside, "legacy.sqlite");
    try {
      const history = await legacyDatabase(source, version);
      const before = await readFile(source);
      const live = new Store(join(directory, "aster.sqlite"));
      live.execute(
        command({
          type: "bot.create",
          name: "替换前的当前库",
          description: "",
        }),
      );
      live.close();
      scheduleRestore(directory, { kind: "file", path: source });
      const result = await applyPendingRestore(directory);
      assert.match(result.notice, /已用备份替换/);
      assert.equal(result.previousAvailable, true);
      assert.deepEqual(await readFile(source), before);
      const restored = new Store(join(directory, "aster.sqlite"));
      try {
        const snapshot = restored.views.snapshot({
          conversationId: history.conversationId,
        });
        assert.equal(snapshot.messages[0]?.text, "升级前的消息");
        assert.deepEqual(
          Buffer.from(
            restored.files.attachmentContent(
              history.conversationId,
              history.attachmentId,
            ).bytes,
          ),
          history.bytes,
        );
        assert.equal(restored.runs.claim(), undefined);
      } finally {
        restored.close();
      }
      scheduleRestore(directory, { kind: "previous" });
      await applyPendingRestore(directory);
      const reverted = new Store(join(directory, "aster.sqlite"));
      try {
        assert.equal(
          reverted.views.snapshot({}).bots[0]?.name,
          "替换前的当前库",
        );
      } finally {
        reverted.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
}
