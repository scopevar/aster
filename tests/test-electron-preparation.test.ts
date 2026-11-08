import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const installer = `const fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(path.join(__dirname, 'installs.txt'), 'installed\\n');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'electron'), 'fixture', { mode: 0o755 });
fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron');`;

// Owner: actual Node/Playwright entry points with an external Electron installer
// fixture. Dev-only coverage cannot catch a runner starting before preparation.
async function fixture(install = installer) {
  const parent = resolve(".runtime/test-results");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "electron-entry-"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  for (const name of ["test.mjs", "dev-process.mjs", "prepare-electron.mjs"])
    await copyFile(join("scripts", name), join(root, "scripts", name));
  const electron = join(root, "node_modules", "electron");
  await mkdir(electron, { recursive: true });
  await writeFile(
    join(electron, "index.js"),
    "throw Error('Do not evaluate Electron while preparing it');",
  );
  await writeFile(join(electron, "install.js"), install);
  await symlink(
    dirname(require.resolve("tsx/package.json")),
    join(root, "node_modules", "tsx"),
    "junction",
  );
  const body = `import { readFileSync } from 'node:fs';
console.log('TEST_BODY_STARTED');
if (readFileSync('node_modules/electron/path.txt', 'utf8') !== 'electron') throw Error('Electron not ready');`;
  await writeFile(join(root, "tests", "daemon-doctor.test.ts"), body);
  await writeFile(
    join(root, "tests", "command-queue.test.ts"),
    "console.log('UNIT_BODY_STARTED');",
  );
  await writeFile(
    join(root, "tests", "guards.test.ts"),
    "console.log('GUARDS_STARTED');",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_OVERRIDE_DIST_PATH: "",
  };
  delete env.NODE_TEST_CONTEXT;
  const run = (args: string[]) =>
    exec(process.execPath, args, {
      cwd: root,
      env,
      timeout: 60000,
      windowsHide: true,
    });
  return { root, electron, run };
}

async function playwrightFixture(install = installer) {
  const context = await fixture(install);
  const { root } = context;
  await mkdir(join(root, "node_modules", "@playwright"));
  await symlink(
    dirname(require.resolve("@playwright/test/package.json")),
    join(root, "node_modules", "@playwright", "test"),
    "junction",
  );
  await copyFile("playwright.config.ts", join(root, "playwright.config.ts"));
  for (const name of ["setup", "e2e", "renderer"])
    await mkdir(join(root, "tests", name));
  await copyFile(
    "tests/setup/electron.setup.ts",
    join(root, "tests/setup/electron.setup.ts"),
  );
  await writeFile(
    join(root, "tests/e2e/probe.spec.ts"),
    `import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
test('desktop probe', () => {
  console.log('DESKTOP_BODY_STARTED');
  expect(readFileSync('node_modules/electron/path.txt', 'utf8')).toBe('electron');
});`,
  );
  await writeFile(
    join(root, "tests/renderer/probe.spec.ts"),
    `import { test } from '@playwright/test';
test('renderer probe', () => { console.log('RENDERER_BODY_STARTED'); });`,
  );
  return {
    ...context,
    playwright: (project: string) =>
      context.run([
        require.resolve("@playwright/test/cli"),
        "test",
        "probe.spec.ts",
        `--project=${project}`,
      ]),
  };
}

await test("core and integration entries prepare missing Electron before tests and reuse it", async () => {
  const { root, electron, run } = await fixture();
  try {
    for (const group of ["core", "integration"]) {
      const result = await run(["scripts/test.mjs", group]);
      assert.match(result.stdout, /TEST_BODY_STARTED/);
      if (group === "integration")
        assert.doesNotMatch(result.stdout, /UNIT_BODY_STARTED/);
      else assert.match(result.stdout, /UNIT_BODY_STARTED/);
      assert.equal(
        await readFile(join(electron, "installs.txt"), "utf8"),
        "installed\n",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The actual runner must isolate the cheap layer and list without preparing
// dependencies. Empty selections must fail instead of discovering every test.
await test("unit and list modes isolate their files without installing Electron", async () => {
  const { root, electron, run } = await fixture();
  try {
    const unit = await run(["scripts/test.mjs", "unit"]);
    assert.match(unit.stdout, /UNIT_BODY_STARTED/);
    assert.doesNotMatch(unit.stdout, /TEST_BODY_STARTED|GUARDS_STARTED/);
    for (const [group, files] of [
      ["unit", ["command-queue.test.ts"]],
      ["integration", ["daemon-doctor.test.ts"]],
      ["core", ["command-queue.test.ts", "daemon-doctor.test.ts"]],
      [
        "all",
        ["command-queue.test.ts", "daemon-doctor.test.ts", "guards.test.ts"],
      ],
    ] as const) {
      const result = await run(["scripts/test.mjs", group, "--list"]);
      assert.deepEqual(
        result.stdout.trim().split(/\r?\n/),
        files.map((file) => join("tests", file)),
      );
    }
    await assert.rejects(
      run(["scripts/test.mjs", "sandbox"]),
      /No tests found/,
    );
    await assert.rejects(readFile(join(electron, "installs.txt")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("guard-only entry does not install Electron", async () => {
  const { root, electron, run } = await fixture();
  try {
    const result = await run(["scripts/test.mjs", "guards"]);
    assert.match(result.stdout, /GUARDS_STARTED/);
    await assert.rejects(readFile(join(electron, "installs.txt")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const exitCode of [0, 7]) {
  await test(`failed Electron preparation (${exitCode}) prevents the Node test body from starting`, async () => {
    const { root, run } = await fixture(
      `console.error('fixture download failed'); process.exitCode = ${exitCode};`,
    );
    try {
      await assert.rejects(
        run(["scripts/test.mjs", "core"]),
        (error: unknown) => {
          assert.ok(
            error instanceof Error && "stdout" in error && "stderr" in error,
          );
          assert.doesNotMatch(String(error.stdout), /TEST_BODY_STARTED/);
          assert.match(String(error.stderr), /fixture download failed/);
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

await test("Playwright prepares desktop dependencies but leaves renderer-only runs untouched", async () => {
  const { root, electron, playwright } = await playwrightFixture();
  try {
    const renderer = await playwright("renderer");
    assert.match(renderer.stdout, /RENDERER_BODY_STARTED/);
    await assert.rejects(readFile(join(electron, "installs.txt")), {
      code: "ENOENT",
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const desktop = await playwright("desktop");
      assert.match(desktop.stdout, /DESKTOP_BODY_STARTED/);
      assert.equal(
        await readFile(join(electron, "installs.txt"), "utf8"),
        "installed\n",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("Playwright blocks desktop tests when Electron preparation fails", async () => {
  const { root, playwright } = await playwrightFixture(
    "console.error('fixture download failed'); process.exitCode = 7;",
  );
  try {
    await assert.rejects(playwright("desktop"), (error: unknown) => {
      assert.ok(
        error instanceof Error && "stdout" in error && "stderr" in error,
      );
      assert.doesNotMatch(String(error.stdout), /DESKTOP_BODY_STARTED/);
      assert.match(
        String(error.stdout) + String(error.stderr),
        /fixture download failed/,
      );
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
