import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/storage/store.js";
import { envelopeSchema } from "../src/shared/commands.js";
import { snapshotUpdateSchema } from "../src/shared/snapshot.js";
import { localWorkspaceStatusSchema } from "../src/shared/local-workspace.js";
import { LocalWorkspace } from "../src/worker/local-workspace.js";
import { startWorker } from "../src/worker/server.js";
import { callWorker } from "../src/worker/client.js";
import {
  defaultSecretBox,
  safeStorageSecretBox,
} from "../src/security/secret.js";

async function legacy(root: string, account: string, name: string) {
  const path = join(
    root,
    "accounts",
    account,
    account === "guest" ? "" : "host-v1",
  );
  await mkdir(join(path, "workspaces"), { recursive: true });
  const store = new Store(join(path, "aster.sqlite"));
  store.execute(
    envelopeSchema.parse({
      id: randomUUID(),
      command: { type: "bot.create", name, description: "retained" },
    }),
  );
  store.close();
  const database = new DatabaseSync(join(path, "aster.sqlite"));
  database.exec("PRAGMA user_version=41");
  database.close();
  await writeFile(
    join(path, "workspaces", "private.txt"),
    "PRIVATE_FILE_CANARY",
  );
  return path;
}

await test("a local workspace link is rejected even when its target contains a valid manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-local-link-"));
  const target = await mkdtemp(join(tmpdir(), "aster-local-link-target-"));
  try {
    const manifest = JSON.stringify({ version: 1, source: null, backup: null });
    await writeFile(join(target, "workspace.json"), manifest);
    await symlink(
      target,
      join(root, "local"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(new LocalWorkspace(root).prepare(), /普通目录/);
    assert.equal(
      await readFile(join(target, "workspace.json"), "utf8"),
      manifest,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

await test("a single legacy guest is backed up and copied without changing originals or device credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-local-migration-"));
  try {
    const source = await legacy(root, "guest", "Guest Bot");
    await mkdir(join(root, "agent"));
    const credential = randomBytes(80);
    await writeFile(join(root, "agent", "pi-auth.sealed"), credential);
    const original = await readFile(join(source, "aster.sqlite"));
    const workspace = new LocalWorkspace(root);
    const state = await workspace.prepare();
    assert.equal(state.ready, true);
    assert.ok(state.backup);
    assert.deepEqual(await readFile(join(source, "aster.sqlite")), original);
    assert.deepEqual(
      await readFile(join(root, "agent", "pi-auth.sealed")),
      credential,
    );
    assert.deepEqual(
      await readFile(join(state.backup, "agent", "pi-auth.sealed")),
      credential,
    );
    assert.equal(
      await readFile(
        join(state.directory, "workspaces", "private.txt"),
        "utf8",
      ),
      "PRIVATE_FILE_CANARY",
    );
    const backup = new Store(join(state.backup, "workspace", "aster.sqlite"));
    assert.equal(backup.views.snapshot({}).bots[0]?.name, "Guest Bot");
    backup.close();
    const worker = await startWorker(root, { port: 0 });
    try {
      const view = snapshotUpdateSchema.parse(
        await callWorker(worker.endpoint, "/snapshot", {}),
      );
      assert.ok(view.changed);
      assert.equal(view.snapshot.bots[0]?.name, "Guest Bot");
      assert.deepEqual(await workspace.prepare(), state);
    } finally {
      await worker.stop();
    }
    assert.deepEqual(await readFile(join(source, "aster.sqlite")), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("multiple accounts require an authenticated explicit choice and never merge or overwrite local data", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-local-choice-"));
  const first = randomUUID(),
    second = randomUUID();
  try {
    await legacy(root, first, "First");
    await legacy(root, second, "Second");
    const worker = await startWorker(root, { port: 0 });
    try {
      const state = localWorkspaceStatusSchema.parse(
        await callWorker(worker.endpoint, "/local-workspace", {
          action: "status",
        }),
      );
      assert.equal(state.ready, false);
      assert.equal(state.sources.length, 2);
      await assert.rejects(
        callWorker(worker.endpoint, "/snapshot", {}),
        /尚未就绪/,
      );
      await assert.rejects(
        callWorker(worker.endpoint, "/local-workspace", {
          action: "select",
          source: "../../private",
        }),
        /请选择/,
      );
      const selected = state.sources.find((entry) =>
        entry.id.startsWith(first),
      );
      assert.ok(selected);
      const migrated = localWorkspaceStatusSchema.parse(
        await callWorker(worker.endpoint, "/local-workspace", {
          action: "select",
          source: selected.id,
        }),
      );
      assert.ok(migrated.backup);
      const view = snapshotUpdateSchema.parse(
        await callWorker(worker.endpoint, "/snapshot", {}),
      );
      assert.ok(view.changed);
      assert.deepEqual(
        view.snapshot.bots.map((bot) => bot.name),
        ["First"],
      );
      await assert.rejects(
        callWorker(worker.endpoint, "/local-workspace", {
          action: "select",
          source: null,
        }),
        /已选择/,
      );
      for (const path of [
        "/account/query",
        "/relay",
        "/machines",
        "/collaboration",
        "/plugins/market",
        "/cloud-chats",
      ])
        await assert.rejects(callWorker(worker.endpoint, path, {}), /未知/);
    } finally {
      await worker.stop();
    }
    const reopened = await startWorker(root, { port: 0 });
    try {
      const view = snapshotUpdateSchema.parse(
        await callWorker(reopened.endpoint, "/snapshot", {}),
      );
      assert.ok(view.changed);
      assert.deepEqual(
        view.snapshot.bots.map((bot) => bot.name),
        ["First"],
      );
    } finally {
      await reopened.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("an unselected workspace can still stop its daemon without touching either legacy source", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-local-unselected-stop-"));
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    await legacy(root, "guest", "Guest");
    await legacy(root, randomUUID(), "Account");
    worker = await startWorker(root, { port: 0 });
    await callWorker(worker.endpoint, "/command", {
      id: randomUUID(),
      command: { type: "worker.stop" },
    });
    await worker.stop();
    assert.equal((await new LocalWorkspace(root).status()).ready, false);
  } finally {
    await worker?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

await test("legacy Windows safeStorage keys are rewrapped for the local path while original ciphertext and backup survive", async (t) => {
  if (process.platform !== "win32")
    return t.skip("Windows OS credential protection");
  const root = await mkdtemp(join(tmpdir(), "aster-local-key-migration-"));
  try {
    const source = await legacy(root, "guest", "Encrypted");
    const original = safeStorageSecretBox(source);
    const sealed = Buffer.from(
      await original.seal(Buffer.from("PLUGIN_TOKEN_CANARY")),
    );
    await writeFile(join(source, "plugin.sealed"), sealed);
    const originalKey = await readFile(join(source, "os-crypt.key"));
    const migrated = await new LocalWorkspace(root).prepare();
    assert.equal(
      Buffer.from(
        await defaultSecretBox(migrated.directory).open(
          await readFile(join(migrated.directory, "plugin.sealed")),
        ),
      ).toString(),
      "PLUGIN_TOKEN_CANARY",
    );
    assert.deepEqual(await readFile(join(source, "os-crypt.key")), originalKey);
    assert.deepEqual(await readFile(join(source, "plugin.sealed")), sealed);
    assert.ok(migrated.backup);
    assert.deepEqual(
      await readFile(join(migrated.backup, "workspace", "os-crypt.key")),
      originalKey,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
