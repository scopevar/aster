import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installedApplicationDirectory } from "../src/platform/application-paths.js";
import {
  saveDatabaseBackup,
  scheduleRestore,
} from "../src/storage/backup/backup.js";
import { saveDiagramFile } from "../src/desktop/native/diagram-export.js";
import { Store } from "../src/storage/store.js";

await test("Desktop and its packaged daemon identify the same relocated installation", () => {
  const application = resolve("relocated", "Aster");
  assert.equal(
    installedApplicationDirectory(join(application, "Aster.exe"), true),
    application,
  );
  assert.equal(
    installedApplicationDirectory(
      join(application, "resources", "daemon-runtime", "node.exe"),
      false,
    ),
    application,
  );
  assert.equal(
    installedApplicationDirectory(join(application, "node.exe"), false),
    undefined,
  );
});

await test("exports and restore protect the actual application without blocking sibling directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-install-paths-"));
  const application = join(root, "Aster");
  const external = join(root, "Aster-exports");
  const data = join(root, "data");
  await Promise.all([application, external, data].map((path) => mkdir(path)));
  const database = join(data, "aster.sqlite");
  const store = new Store(database);
  store.close();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>test</text></svg>';
  try {
    const original = join(application, "keep.sqlite");
    await writeFile(original, "installed application content");
    await assert.rejects(
      saveDatabaseBackup(data, original, application),
      /已安装程序目录/,
    );
    assert.equal(
      await readFile(original, "utf8"),
      "installed application content",
    );
    assert.throws(
      () =>
        scheduleRestore(data, { kind: "file", path: original }, application),
      /已安装程序目录/,
    );
    await assert.rejects(
      saveDiagramFile(join(application, "chart.svg"), svg, application),
      /已安装程序目录/,
    );
    assert.equal(
      await saveDatabaseBackup(
        data,
        join(external, "backup.sqlite"),
        application,
      ),
      "backup.sqlite",
    );
    assert.equal(
      await saveDiagramFile(join(external, "chart.svg"), svg, application),
      "chart.svg",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
