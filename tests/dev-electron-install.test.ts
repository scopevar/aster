import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const environment = pathToFileURL(resolve("scripts/dev-environment.mjs")).href;

async function fixture(installer: string) {
  const root = await mkdtemp(join(tmpdir(), "aster-electron-install-"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  for (const name of ["esbuild", "sharp", "electron", "electron-vite"]) {
    const directory = join(root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "index.js"),
      "throw Error('Dependencies must not be evaluated');",
    );
  }
  const electron = join(root, "node_modules", "electron");
  await writeFile(join(electron, "install.js"), installer);
  await mkdir(join(root, "assets"));
  for (const file of ["aster-icon.png"])
    await writeFile(join(root, "assets", file), "fixture");
  const run = (installElectron: boolean) =>
    exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {inspectDevEnvironment} from ${JSON.stringify(environment)};console.log('READY='+await inspectDevEnvironment(${JSON.stringify(root)}, {installElectron:${installElectron}, signal:new AbortController().signal}));`,
      ],
      {
        env: {
          ...process.env,
          ELECTRON_OVERRIDE_DIST_PATH: "",
          DISPLAY: ":test",
        },
      },
    );
  return { root, electron, run };
}

await test(
  "missing Electron is installed for dev, reused afterwards, and never downloaded by inspection",
  { skip: process.platform === "linux" && process.getuid?.() === 0 },
  async () => {
    const { root, electron, run } = await fixture(
      "const fs=require('node:fs');const path=require('node:path');fs.appendFileSync(path.join(__dirname,'installs.txt'),'installed\\n');fs.mkdirSync(path.join(__dirname,'dist'));fs.writeFileSync(path.join(__dirname,'dist','electron'),'fixture',{mode:0o755});fs.writeFileSync(path.join(__dirname,'path.txt'),'electron');",
    );
    try {
      const doctor = await run(false);
      assert.match(doctor.stdout, /READY=false/);
      await assert.rejects(readFile(join(electron, "installs.txt")), {
        code: "ENOENT",
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await run(true);
        assert.doesNotMatch(result.stdout, /✓ Electron 程序/);
        assert.match(result.stdout, /READY=true/);
        assert.equal(
          await readFile(join(electron, "installs.txt"), "utf8"),
          "installed\n",
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const exitCode of [0, 7])
  await test(
    `Electron installation without a binary blocks startup even with exit code ${exitCode}`,
    { skip: process.platform === "linux" && process.getuid?.() === 0 },
    async () => {
      const { root, run } = await fixture(
        `console.error('fixture download failure');process.exitCode=${exitCode};`,
      );
      try {
        const result = await run(true);
        assert.match(result.stdout, /正在自动下载安装/);
        assert.match(result.stdout, /✗ Electron 程序：未安装或不可执行/);
        assert.match(result.stdout, /READY=false/);
        assert.match(result.stderr, /fixture download failure/);
        if (exitCode !== 0)
          assert.match(result.stderr, /Electron 自动安装失败，退出码：7/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
