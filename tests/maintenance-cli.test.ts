import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

await test("maintenance never evaluates the Electron download entry and unverified desktop locks block updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-readonly-doctor-"));
  const electron = join(root, "node_modules", "electron");
  const marker = join(root, "download-attempted");
  const cli = join(root, "maintenance.mjs");
  const distEntry = join(root, "dist", "desktop", "worker-maintenance-cli.js");
  await mkdir(join(electron, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await mkdir(join(root, "dist", "desktop"), { recursive: true });
  await writeFile(distEntry, "old build must remain untouched");
  await writeFile(
    join(electron, "index.js"),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'download');throw Error('download');`,
  );
  await build({
    entryPoints: ["src/desktop/worker/worker-maintenance-cli.ts"],
    outfile: cli,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
  });
  // Exercise the actual temporary bundle path, independently of the direct CLI tests.
  const runtimeEntry = join(root, "runtime.mjs");
  await symlink(resolve("src"), join(root, "src"), "junction");
  await writeFile(
    runtimeEntry,
    `import {maintainRuntime} from ${JSON.stringify(pathToFileURL(resolve("scripts/dev-runtime.mjs")).href)}; process.exitCode = await maintainRuntime(${JSON.stringify(root)}, 'doctor');`,
  );
  async function run(action: string) {
    const child = spawn(process.execPath, [cli, action, root], {
      env: { ...process.env, ASTER_DATA_DIR: root },
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, output };
  }
  try {
    const runtime = spawn(process.execPath, [runtimeEntry], {
      env: { ...process.env, ASTER_DATA_DIR: root },
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      runtime.once("error", reject);
      runtime.once("close", resolve);
    });
    assert.equal(code, 2, "missing Electron must remain a diagnostic failure");
    assert.equal(
      await readFile(distEntry, "utf8"),
      "old build must remain untouched",
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    for (const pathFile of [false, true]) {
      if (pathFile) await writeFile(join(electron, "path.txt"), "electron");
      const doctor = await run("doctor");
      assert.equal(doctor.code, 2);
      assert.match(doctor.output, /未自动下载/);
      assert.doesNotMatch(doctor.output, /检查通过|启动成功/);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    }
    const executable = join(electron, "dist", "electron");
    if (process.platform === "win32")
      await copyFile(process.execPath, executable);
    else await symlink(process.execPath, executable);
    if (process.platform === "linux") {
      await mkdir(join(root, "desktop"));
      const lock = join(root, "desktop", "SingletonLock");
      await symlink("previous-host-12345", lock);
      for (const action of ["doctor", "restart"]) {
        const failed = await run(action);
        assert.equal(failed.code, 2);
        assert.match(failed.output, /rm -- .*SingletonLock/);
        assert.match(failed.output, /仅删除残留实例锁/);
      }
      assert.equal(
        await readFile(join(electron, "path.txt"), "utf8"),
        "electron",
      );
    }
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
