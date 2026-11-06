import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import type { Command } from "../src/shared/commands.js";
import {
  applyPendingRestore,
  readBackupStatus,
  saveDatabaseBackup,
  scheduleRestore,
} from "../src/storage/backup/backup.js";
import { Store } from "../src/storage/store.js";
import { localWorkspaceDirectory } from "../src/platform/app-data-directory.js";
import { startWorker } from "../src/worker/server.js";
import { lockFile } from "./helpers/windows-file-lock.js";
import { fullSnapshotOf } from "./helpers/worker-snapshot.js";

const command = (command: Command) => ({
  id: randomUUID(),
  command,
});
const beforeCommit = new Set([
  "prepared",
  "displaced",
  "installed-before-commit",
  "journal-write-failure",
]);
for (const phase of [
  ...beforeCommit,
  "committed",
  "previous-held",
  "previous-promoted",
  "result-recorded",
  "request-removed",
  "prior-removed",
  "journal-removed",
]) {
  await test(`restore ${phase === "journal-write-failure" ? "write failure" : "process exit"} at ${phase} preserves the committed database and previous copy`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "aster-restore-crash-"));
    const outside = await mkdtemp(join(tmpdir(), "aster-restore-snapshot-"));
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      const accountDir = localWorkspaceDirectory(directory);
      await mkdir(accountDir, { recursive: true });
      const source = join(outside, "snapshot.sqlite");
      const live = join(accountDir, "aster.sqlite");
      const store = new Store(live);
      const bot = store.execute(
        command({ type: "bot.create", name: "Snapshot", description: "" }),
      );
      assert.ok(bot.conversationId);
      const bytes = Buffer.from(`ATTACHMENT_${randomUUID()}`);
      const attachment = store.files.registerAttachment(
        {
          id: randomUUID(),
          conversationId: bot.conversationId,
          name: "proof.txt",
        },
        bytes,
      );
      await saveDatabaseBackup(accountDir, source);
      store.execute(
        command({ type: "bot.create", name: "Current", description: "" }),
      );
      store.close();
      const older = new Store(join(accountDir, "aster.sqlite.previous"));
      older.execute(
        command({ type: "bot.create", name: "Older", description: "" }),
      );
      older.close();
      scheduleRestore(accountDir, { kind: "file", path: source });
      const child = promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("tests/fixtures/crash-restore.mjs"),
          accountDir,
          phase,
        ],
        {
          windowsHide: true,
          timeout: 20000,
          maxBuffer: 65536,
        },
      );
      if (phase === "journal-write-failure") await child;
      else
        await assert.rejects(
          child,
          (error) =>
            error instanceof Error && "code" in error && error.code === 73,
        );
      // Recovery must use its committed staging records even when the external backup is gone.
      await rm(source);
      worker = await startWorker(directory);
      const response = await fetch(
        `http://127.0.0.1:${worker.endpoint.port}/snapshot`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${worker.endpoint.token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
          signal: AbortSignal.timeout(10000),
        },
      );
      assert.equal(response.status, 200);
      const state = fullSnapshotOf(await response.json());
      assert.deepEqual(
        state.bots.map((bot) => bot.name).sort(),
        beforeCommit.has(phase) ? ["Current", "Snapshot"] : ["Snapshot"],
      );
      const data = new DatabaseSync(join(accountDir, "aster.sqlite"), {
        readOnly: true,
      });
      try {
        assert.deepEqual(data.prepare("PRAGMA foreign_key_check").all(), []);
        assert.equal(
          data.prepare("PRAGMA integrity_check").get()?.integrity_check,
          "ok",
        );
        const retained = data
          .prepare("SELECT data FROM attachments WHERE id=?")
          .get(attachment.id)?.data;
        assert.ok(retained instanceof Uint8Array);
        assert.ok(Buffer.from(retained).equals(bytes));
      } finally {
        data.close();
      }
      const previous = new DatabaseSync(
        join(accountDir, "aster.sqlite.previous"),
        { readOnly: true },
      );
      try {
        assert.deepEqual(
          previous
            .prepare("SELECT name FROM bots ORDER BY name")
            .all()
            .map((row) => row.name),
          beforeCommit.has(phase) ? ["Older"] : ["Current", "Snapshot"],
        );
        assert.equal(
          previous.prepare("PRAGMA integrity_check").get()?.integrity_check,
          "ok",
        );
      } finally {
        previous.close();
      }
      assert.equal(readBackupStatus(accountDir).pending, false);
      assert.equal(
        existsSync(join(accountDir, "restore-transaction.json")),
        false,
      );
      assert.deepEqual(
        readdirSync(accountDir).filter((name) => name.startsWith(".restore-")),
        [],
      );
    } finally {
      await worker?.stop();
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
}

await test("invalid restore journals block worker startup without creating an empty database or removing artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-broken-journal-"));
  try {
    const accountDir = localWorkspaceDirectory(directory);
    await mkdir(accountDir, { recursive: true });
    const artifact = join(
      accountDir,
      `.restore-displaced-${randomUUID()}.sqlite`,
    );
    await writeFile(artifact, "retained bytes");
    const journal = join(accountDir, "restore-transaction.json");
    for (const data of [
      "{broken",
      JSON.stringify({
        version: 1,
        id: "../outside",
        hadLive: true,
        phase: "prepared",
      }),
    ]) {
      await writeFile(journal, data);
      await assert.rejects(startWorker(directory), /恢复日志损坏/);
      assert.equal(existsSync(join(accountDir, "aster.sqlite")), false);
      assert.equal(await readFile(artifact, "utf8"), "retained bytes");
      assert.equal(await readFile(journal, "utf8"), data);
    }
    await rm(journal);
    await assert.rejects(startWorker(directory), /未确认的旧恢复副本/);
    assert.equal(existsSync(join(accountDir, "aster.sqlite")), false);
    assert.equal(await readFile(artifact, "utf8"), "retained bytes");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("overwriting a backup atomically preserves an unrelated .replaced file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-save-replace-"));
  const outside = await mkdtemp(join(tmpdir(), "aster-save-destination-"));
  const store = new Store(join(directory, "aster.sqlite"));
  try {
    const destination = join(outside, "snapshot.sqlite");
    await saveDatabaseBackup(directory, destination);
    await writeFile(`${destination}.replaced`, "unrelated user file");
    store.execute(
      command({ type: "bot.create", name: "Fresh", description: "" }),
    );
    await saveDatabaseBackup(directory, destination);
    assert.equal(
      await readFile(`${destination}.replaced`, "utf8"),
      "unrelated user file",
    );
    const backup = new DatabaseSync(destination, { readOnly: true });
    try {
      assert.equal(
        backup.prepare("SELECT name FROM bots").get()?.name,
        "Fresh",
      );
    } finally {
      backup.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

await test(
  "a real Windows result-file lock preserves a committed restore and resumes after release",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "aster-restore-locked-"));
    const outside = await mkdtemp(
      join(tmpdir(), "aster-restore-locked-source-"),
    );
    let lock: Awaited<ReturnType<typeof lockFile>> | undefined;
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      const accountDir = localWorkspaceDirectory(directory);
      await mkdir(accountDir, { recursive: true });
      const source = join(outside, "saved.sqlite");
      const store = new Store(join(accountDir, "aster.sqlite"));
      store.execute(
        command({ type: "bot.create", name: "Saved", description: "" }),
      );
      await saveDatabaseBackup(accountDir, source);
      store.execute(
        command({ type: "bot.create", name: "Later", description: "" }),
      );
      store.close();
      scheduleRestore(accountDir, { kind: "file", path: source });
      const result = join(accountDir, "restore-result.json");
      await writeFile(
        result,
        JSON.stringify({ version: 1, status: "failed", message: "old result" }),
      );
      lock = await lockFile(result, 0);
      await assert.rejects(startWorker(directory), /收尾尚未完成/);
      assert.equal(
        existsSync(join(accountDir, "restore-transaction.json")),
        true,
      );
      const previous = new DatabaseSync(
        join(accountDir, "aster.sqlite.previous"),
        {
          readOnly: true,
        },
      );
      try {
        assert.equal(
          previous.prepare("SELECT count(*) n FROM bots").get()?.n,
          2,
        );
      } finally {
        previous.close();
      }
      await lock.close();
      lock = undefined;
      worker = await startWorker(directory);
      assert.match(readBackupStatus(accountDir).notice, /已用备份替换/);
      assert.equal(
        existsSync(join(accountDir, "restore-transaction.json")),
        false,
      );
      const current = new DatabaseSync(join(accountDir, "aster.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(
          current.prepare("SELECT count(*) n FROM bots").get()?.n,
          1,
        );
      } finally {
        current.close();
      }
    } finally {
      await lock?.close();
      await worker?.stop();
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
);

await test("a busy WAL checkpoint refuses replacement and keeps committed writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-restore-busy-"));
  const outside = await mkdtemp(join(tmpdir(), "aster-restore-busy-source-"));
  const path = join(directory, "aster.sqlite");
  const store = new Store(path);
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    const source = join(outside, "saved.sqlite");
    await saveDatabaseBackup(directory, source);
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM bots").all();
    store.execute(
      command({ type: "bot.create", name: "Kept in WAL", description: "" }),
    );
    scheduleRestore(directory, { kind: "file", path: source });
    const status = await applyPendingRestore(directory);
    assert.match(status.notice, /仍被占用/);
    assert.equal(existsSync(`${path}-wal`), true);
    assert.equal(
      existsSync(join(directory, "restore-transaction.json")),
      false,
    );
    assert.equal(store.views.snapshot({}).bots[0]?.name, "Kept in WAL");
    reader.exec("ROLLBACK");
  } finally {
    reader.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
