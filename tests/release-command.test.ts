import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../scripts/release.ts", import.meta.url));

// The real entry must guide local users without requiring a release environment;
// retired flags must fail, while --ci still reaches the workflow command parser.
void test("release entry shows local guidance, rejects retired flags and routes CI commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-release-command-"));
  const run = (args: string[]) =>
    exec(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), entry, ...args],
      {
        cwd: root,
        windowsHide: true,
        timeout: 10000,
      },
    );
  try {
    for (const args of [[], ["--help"]]) {
      const result = await run(args);
      assert.match(result.stdout, /GitHub Actions/);
      assert.match(result.stdout, /docs\/releasing\.md/);
      assert.equal(result.stderr, "");
    }
    for (const args of [["--dry-run"], ["--bump", "minor"], ["--resume"]])
      await assert.rejects(run(args), {
        code: 1,
        stderr: /不支持本地发布参数/,
      });
    await assert.rejects(run(["--ci", "unknown"]), {
      code: 1,
      stderr: /用法：pnpm release --ci plan/,
    });
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
