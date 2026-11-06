import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
const exec = promisify(execFile);
const libraries = pathToFileURL(resolve("scripts/dev-libraries.mjs")).href;

await test(
  "library inspection distinguishes unavailable ldd from confirmed missing libraries",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aster-ldd-"));
    const empty = join(root, "empty");
    await mkdir(empty);
    const run = async (path: string) => {
      const result = await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {inspectLinuxLibraries} from ${JSON.stringify(libraries)};console.log(JSON.stringify(await inspectLinuxLibraries('/unused')));`,
        ],
        { env: { ...process.env, PATH: path } },
      );
      const value: unknown = JSON.parse(result.stdout);
      return value;
    };
    try {
      assert.deepEqual(await run(empty), {
        state: "unchecked",
        detail: "未安装 ldd，系统库未检查",
        action:
          "可安装提供 ldd 的软件包后执行 pnpm dev --doctor；仍可尝试 pnpm dev，若提示缺少共享库再安装对应软件包。",
      });
      const ldd = join(root, "ldd");
      await writeFile(ldd, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const unknown = await run(root);
      assert.ok(unknown && typeof unknown === "object" && "state" in unknown);
      assert.equal(unknown.state, "unchecked");
      for (const status of [0, 1]) {
        await writeFile(
          ldd,
          `#!/bin/sh\nprintf 'libnss3.so => not found\\n'\nexit ${status}\n`,
          { mode: 0o755 },
        );
        const missing = await run(root);
        assert.ok(
          missing &&
            typeof missing === "object" &&
            "state" in missing &&
            "detail" in missing,
        );
        assert.equal(missing.state, "missing");
        assert.match(String(missing.detail), /libnss3/);
      }
      await writeFile(
        ldd,
        "#!/bin/sh\nprintf 'libnss3.so => /lib/libnss3.so (0x123)\\n'\n",
        { mode: 0o755 },
      );
      const ready = await run(root);
      assert.ok(ready && typeof ready === "object" && "state" in ready);
      assert.equal(ready.state, "ready");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

await test(
  "apt package hints cover Debian, Ubuntu and derivatives with distribution and local metadata time64 detection",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aster-library-packages-"));
    const run = async (release: string) => {
      const result = await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {libraryAction} from ${JSON.stringify(libraries)};console.log(libraryAction(['libnss3.so => not found','libasound.so.2 => not found'], ${JSON.stringify(release)}));`,
        ],
        { env: { ...process.env, PATH: root } },
      );
      return result.stdout;
    };
    try {
      await writeFile(join(root, "apt-cache"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      for (const release of [
        "ID=ubuntu\nVERSION_ID=22.04",
        "ID=debian\nVERSION_ID=12",
        'ID=pop\nID_LIKE="ubuntu debian"\nVERSION_ID=22.04',
        'ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_ID=21.3',
      ])
        assert.match(
          await run(release),
          /sudo apt install libnss3 libasound2。/,
        );
      for (const release of [
        "ID=ubuntu\nVERSION_ID=24.04",
        "ID=debian\nVERSION_ID=13",
        'ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_ID=22',
        'ID=pop\nID_LIKE="ubuntu debian"\nVERSION_ID=24.04',
        'ID=custom\nID_LIKE="ubuntu debian"\nUBUNTU_CODENAME=noble',
      ])
        assert.match(
          await run(release),
          /sudo apt install libnss3 libasound2t64。/,
        );
      await writeFile(
        join(root, "apt-cache"),
        "#!/bin/sh\nprintf 'Package: libasound2t64\\n'\n",
        { mode: 0o755 },
      );
      assert.match(
        await run("ID=custom\nID_LIKE=debian"),
        /sudo apt install libnss3 libasound2t64。/,
      );
      assert.match(
        await run("ID=arch"),
        /当前发行版的包管理器.*libnss3.so.*libasound.so.2/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

await test(
  "dev readiness tolerates unchecked libraries but requires libraries and the application icon",
  { skip: process.platform !== "linux" || process.getuid?.() === 0 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aster-environment-ready-"));
    const environment = pathToFileURL(
      resolve("scripts/dev-environment.mjs"),
    ).href;
    try {
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      for (const name of ["esbuild", "sharp", "electron", "electron-vite"]) {
        const dependency = join(root, "node_modules", name);
        await mkdir(dependency, { recursive: true });
        await writeFile(
          join(dependency, "index.js"),
          "throw Error('Dependencies must not be evaluated');",
        );
      }
      const electron = join(root, "node_modules", "electron");
      await mkdir(join(electron, "dist"));
      await writeFile(join(electron, "path.txt"), "electron");
      await symlink(process.execPath, join(electron, "dist", "electron"));
      await mkdir(join(root, "assets"));
      await writeFile(join(root, "assets", "aster-icon.png"), "fixture");
      const ldd = join(root, "ldd");
      const run = () =>
        exec(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import {inspectDevEnvironment} from ${JSON.stringify(environment)};console.log('READY='+await inspectDevEnvironment(${JSON.stringify(root)}));`,
          ],
          { env: { ...process.env, PATH: root, DISPLAY: ":test" } },
        );
      for (const missing of [false, true]) {
        await writeFile(
          ldd,
          missing
            ? "#!/bin/sh\nprintf 'libnss3.so => not found\\n'\nexit 1\n"
            : "#!/bin/sh\nexit 1\n",
          { mode: 0o755 },
        );
        const result = await run();
        assert.match(result.stdout, missing ? /READY=false/ : /READY=true/);
        // A healthy environment must stay silent; only failures are reported.
        assert.doesNotMatch(result.stdout, /✓/);
        assert.match(
          result.stdout,
          missing ? /libnss3.so => not found/ : /系统库状态未知/,
        );
      }
      await writeFile(ldd, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      for (const [name, file] of [
        ["应用图标原图", "aster-icon.png"],
      ] as const) {
        await rm(join(root, "assets", file));
        const result = await run();
        assert.match(result.stdout, /READY=false/);
        assert.ok(result.stdout.includes(`✗ ${name}：缺少 assets/${file}`));
        assert.ok(result.stderr.includes(`git restore -- assets/${file}`));
        await writeFile(join(root, "assets", file), "fixture");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
