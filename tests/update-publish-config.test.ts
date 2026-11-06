import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const config = new URL("../electron-builder.js", import.meta.url).href;

// Read the actual builder configuration in isolated processes, as packaging does.
void test("packaging uses the public GitHub repository without embedding credentials", async () => {
  const env = { ...process.env };
  for (const key of [
    "ASTER_UPDATE_REPOSITORY",
    "ASTER_UPDATE_URL",
    "GITHUB_REPOSITORY",
    "ASTER_RELEASE_CHANNEL",
  ])
    delete env[key];
  const run = async (overrides: NodeJS.ProcessEnv = {}) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import config from ${JSON.stringify(config)};console.log(JSON.stringify(config.publish));`,
          ],
          { env: { ...env, ...overrides } },
        )
      ).stdout,
    ) as unknown;
  assert.equal(await run({ GH_TOKEN: "must-not-enable-local-updates" }), null);
  assert.deepEqual(
    await run({
      GITHUB_REPOSITORY: "scopevar/aster",
      GH_TOKEN: "must-not-be-packaged",
    }),
    [
      {
        provider: "github",
        owner: "scopevar",
        repo: "aster",
        channel: "latest",
        releaseType: "release",
      },
    ],
  );
  assert.deepEqual(
    await run({
      ASTER_UPDATE_REPOSITORY: "scopevar/aster",
      ASTER_RELEASE_CHANNEL: "nightly",
      ASTER_UPDATE_URL: "https://old.example/",
    }),
    [
      {
        provider: "github",
        owner: "scopevar",
        repo: "aster",
        channel: "nightly",
        releaseType: "prerelease",
      },
    ],
  );
  await assert.rejects(
    run({ ASTER_UPDATE_REPOSITORY: "https://github.com/scopevar/aster" }),
    /owner\/repo/,
  );
});
