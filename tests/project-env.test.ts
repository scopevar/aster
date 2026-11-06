import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const exec = promisify(execFile);
const loader = new URL("../scripts/project-env.mjs", import.meta.url).href;

await test("project env reads the selected root, preserves shell overrides and permits a missing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-project-env-"));
  const env = { ...process.env };
  for (const key of ["ASTER_DATA_DIR"]) delete env[key];
  const code = `import {loadProjectEnv} from ${JSON.stringify(loader)};loadProjectEnv(${JSON.stringify(root)});console.log(JSON.stringify({ASTER_DATA_DIR:process.env.ASTER_DATA_DIR}));`;
  const run = (overrides: NodeJS.ProcessEnv = {}) =>
    exec(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...env, ...overrides },
    });
  try {
    assert.deepEqual(JSON.parse((await run()).stdout), {});
    await writeFile(
      join(root, ".env"),
      "# 本地目录\nASTER_DATA_DIR=./local-data\nAWS_SECRET_ACCESS_KEY=private-fixture-key\n",
    );
    assert.deepEqual(JSON.parse((await run()).stdout), {
      ASTER_DATA_DIR: "./local-data",
    });
    assert.deepEqual(
      JSON.parse((await run({ ASTER_DATA_DIR: "./shell-data" })).stdout),
      {
        ASTER_DATA_DIR: "./shell-data",
      },
    );
    await rm(join(root, ".env"));
    await mkdir(join(root, ".env"));
    await assert.rejects(run(), /无法读取项目 .env/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
