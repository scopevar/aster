import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "../src/storage/store.js";
import { localWorkspaceDirectory } from "../src/platform/app-data-directory.js";

await test("39 to 40 retains history and old outbox without claiming old work; backup restore removes device trust", async () => {
  // Contract: the additive migration retains user data, fences old execution and
  // restored copies cannot become a second host with the original device keys.
  const directory = await mkdtemp(join(tmpdir(), "aster-relay-migration-")),
    path = join(directory, "old.sqlite");
  let store = new Store(path);
  const created = store.execute({
    id: randomUUID(),
    command: { type: "bot.create", name: "Old local history", description: "" },
  });
  assert.ok(created.conversationId);
  const run = store.execute({
    id: randomUUID(),
    command: {
      type: "message.send",
      conversationId: created.conversationId,
      text: "old queued task",
    },
  });
  assert.ok(run.id);
  const before = 1;
  store.close();
  // Remove exactly the new additive module to build a genuine v39 fixture with
  // the same business tables, messages, queued run and legacy cloud outbox.
  const legacy = new DatabaseSync(path);
  legacy
    .prepare(
      "INSERT INTO cloud_chat_outbox(id,kind,entityId,body) VALUES(?,?,?,?)",
    )
    .run(randomUUID(), "message", randomUUID(), "legacy retained body");
  legacy.exec(
    "DROP TABLE group_discussions; ALTER TABLE groups DROP COLUMN hostBotId;",
  );
  for (const row of legacy
    .prepare(
      "SELECT name,type FROM sqlite_master WHERE name GLOB 'relay_*' AND type IN ('trigger','table') ORDER BY CASE type WHEN 'trigger' THEN 0 ELSE 1 END",
    )
    .all()) {
    assert.equal(typeof row.name, "string");
    assert.match(String(row.name), /^relay_[a-z_]+$/);
    legacy.exec(`DROP ${String(row.type).toUpperCase()} "${String(row.name)}"`);
  }
  legacy.exec("PRAGMA user_version=39");
  legacy.close();
  try {
    store = new Store(path);
    store.recover();
    assert.equal(
      store.snapshotSince({ conversationId: created.conversationId })
        ?.messages[0]?.text,
      "old queued task",
    );
    const inspected = new DatabaseSync(path);
    assert.equal(
      inspected.prepare("SELECT count(*) n FROM cloud_chat_outbox").get()?.n,
      before,
    );
    assert.equal(
      inspected.prepare("SELECT enabled FROM cloud_chat_state").get()?.enabled,
      0,
    );
    inspected.close();
    assert.equal(store.runs.getRun(run.id)?.status, "unknown");
    assert.equal(store.runs.claim(), undefined);
    const trust = new DatabaseSync(path);
    trust
      .prepare("INSERT INTO relay_settings VALUES('identity',?)")
      .run('"sealed old identity"');
    trust.close();
    store.prepareRestoredSnapshot();
    const restored = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      restored.prepare("SELECT count(*) n FROM relay_settings").get()?.n,
      0,
    );
    assert.equal(
      restored.prepare("SELECT count(*) n FROM relay_peers").get()?.n,
      0,
    );
    restored.close();
    assert.equal(
      store.snapshotSince({ conversationId: created.conversationId })
        ?.messages[0]?.text,
      "old queued task",
    );
    assert.equal(localWorkspaceDirectory(directory), join(directory, "local"));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
