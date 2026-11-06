import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { maxDatabaseVersion } from "../src/shared/backup.js";
import {
  assertMigrationRegistry,
  schemaMigrations,
  type Migration,
} from "../src/storage/migrations/migration-registry.js";
import { Store } from "../src/storage/store.js";
import { legacyDatabase } from "./helpers/legacy-database.js";

const fixtureDir = join(import.meta.dirname, "fixtures", "schema");

function dump(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return `${JSON.stringify(
      db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name",
        )
        .all(),
    )}\n`;
  } finally {
    db.close();
  }
}

function openFresh(path: string) {
  const store = new Store(path);
  store.close();
}

await test("fresh schema matches the current baseline", () => {
  const freshDir = mkdtempSync(join(tmpdir(), "aster-schema-fresh-"));
  const freshPath = join(freshDir, "aster.sqlite");
  try {
    openFresh(freshPath);
    assert.equal(
      dump(freshPath),
      readFileSync(join(fixtureDir, "fresh.txt"), "utf8").replace(
        /\r\n$/,
        "\n",
      ),
    );
  } finally {
    rmSync(freshDir, { recursive: true, force: true });
  }
});

for (const version of [9, 24, 32] as const) {
  await test(`v${version} upgrades preserve history, attachments and committed WAL, keep a rollback copy and never replay interrupted work`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `aster-schema-v${version}-`));
    const path = join(directory, "aster.sqlite");
    const history = await legacyDatabase(path, version);
    const writer = new DatabaseSync(path);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      writer
        .prepare("UPDATE conversations SET draft=? WHERE id=?")
        .run("已提交到 WAL 的草稿", history.conversationId);
      const store = new Store(path);
      try {
        store.recover();
        const snapshot = store.views.snapshot({
          conversationId: history.conversationId,
        });
        assert.equal(snapshot.bots[0]?.name, "升级前的 Bot");
        assert.equal(snapshot.messages[0]?.text, "升级前的消息");
        assert.equal(snapshot.conversations[0]?.draft, "已提交到 WAL 的草稿");
        assert.deepEqual(
          Buffer.from(
            store.files.attachmentContent(
              history.conversationId,
              history.attachmentId,
            ).bytes,
          ),
          history.bytes,
        );
        assert.equal(
          store.runs.getRun(history.pendingRunId)?.status,
          "unknown",
        );
        assert.equal(store.runs.claim(), undefined);
      } finally {
        store.close();
      }
      const copies = () =>
        readdirSync(directory).filter(
          (name) =>
            name.startsWith(`aster.sqlite.pre-upgrade-v${version}-`) &&
            name.endsWith(".sqlite"),
        );
      assert.equal(copies().length, 1);
      const previous = new DatabaseSync(join(directory, copies()[0]!), {
        readOnly: true,
      });
      try {
        assert.equal(
          previous.prepare("PRAGMA user_version").get()?.user_version,
          version,
        );
        assert.equal(
          previous.prepare("PRAGMA integrity_check").get()?.integrity_check,
          "ok",
        );
        assert.equal(
          previous
            .prepare("SELECT draft FROM conversations WHERE id=?")
            .get(history.conversationId)?.draft,
          "已提交到 WAL 的草稿",
        );
        const savedBytes = previous
          .prepare("SELECT data FROM attachments WHERE id=?")
          .get(history.attachmentId)?.data;
        assert.ok(savedBytes instanceof Uint8Array);
        assert.deepEqual(Buffer.from(savedBytes), history.bytes);
      } finally {
        previous.close();
      }
      openFresh(path);
      assert.equal(copies().length, 1);
    } finally {
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

await test("a later migration failure rolls back every step and retains the original history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aster-schema-rollback-"));
  const path = join(directory, "aster.sqlite");
  try {
    const history = await legacyDatabase(path, 9);
    const damaged = new DatabaseSync(path);
    damaged.exec("CREATE TABLE bot_avatar_images(incompatible INTEGER)");
    damaged.close();
    const before = dump(path);
    assert.throws(() => openFresh(path), /bot_avatar_images|already exists/);
    assert.equal(dump(path), before);
    const original = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        original.prepare("PRAGMA user_version").get()?.user_version,
        9,
      );
      assert.equal(
        original
          .prepare("SELECT text FROM messages WHERE id=?")
          .get(history.messageId)?.text,
        "升级前的消息",
      );
    } finally {
      original.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("invalid legacy references cannot commit an upgrade with foreign-key checking deferred", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aster-schema-invalid-"));
  const path = join(directory, "aster.sqlite");
  try {
    const history = await legacyDatabase(path, 32);
    const damaged = new DatabaseSync(path);
    damaged.exec("PRAGMA foreign_keys=OFF");
    damaged.prepare("DELETE FROM bots WHERE id=?").run(history.botId);
    damaged.close();
    const before = dump(path);
    assert.throws(() => openFresh(path), /数据关联校验未通过/);
    assert.equal(dump(path), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("unsupported and newer database versions are rejected without changing the original file", async () => {
  for (const version of [1, maxDatabaseVersion + 1]) {
    const directory = mkdtempSync(join(tmpdir(), "aster-schema-unsupported-"));
    const path = join(directory, "aster.sqlite");
    try {
      await legacyDatabase(path, 9);
      const original = new DatabaseSync(path);
      original.exec(`PRAGMA user_version=${version}`);
      original.close();
      const before = readFileSync(path);
      assert.throws(() => openFresh(path), /版本/);
      assert.deepEqual(readFileSync(path), before);
      assert.equal(
        readdirSync(directory).some((name) => name.includes("pre-upgrade")),
        false,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

await test("migration registry is consecutive through maxDatabaseVersion", () => {
  const noop = () => {};
  const migrations = schemaMigrations({
    plugins: { migrate: noop },
    pluginCalls: { migrate: noop },
    groups: { migrate: noop },
    avatars: { migrate: noop },
    skills: { migrate: noop },
    memory: { migrate: noop },
    sharedMemory: { migrate: noop },
    toolCalls: { migrate: noop },
    questions: { migrate: noop },
    skillTools: { migrate: noop },
    deletions: { migrate: noop },
    sidebar: { migrate: noop },
    documents: { migrate: noop, migrateOffice: noop },
    routines: { repository: { migrate: noop } },
    templates: { migrate: noop },
    templateTools: { migrate: noop },
  });
  assertMigrationRegistry(migrations);
  assert.equal(migrations[0]?.version, 2);
  assert.equal(migrations.at(-1)?.version, maxDatabaseVersion);
  assert.equal(migrations.length, maxDatabaseVersion - 1);
  assert.equal(
    new Set(migrations.map((item) => item.version)).size,
    migrations.length,
  );
});

await test("migration registry rejects gaps, duplicates and a wrong maximum", () => {
  const migrate = () => {};
  const step = (version: number): Migration => ({
    version,
    module: "core",
    migrate,
  });
  assert.throws(() => assertMigrationRegistry([]), /为空/);
  assert.throws(() => assertMigrationRegistry([step(1)]), /版本 2/);
  assert.throws(() => assertMigrationRegistry([step(2), step(2)]), /重复/);
  assert.throws(() => assertMigrationRegistry([step(2), step(4)]), /不连续/);
  assert.throws(
    () => assertMigrationRegistry([step(2), step(3)]),
    /maxDatabaseVersion/,
  );
  assert.throws(
    () =>
      assertMigrationRegistry([
        { version: 2, module: " ", migrate },
        ...Array.from({ length: maxDatabaseVersion - 2 }, (_, index) =>
          step(index + 3),
        ),
      ]),
    /所属模块/,
  );
});
