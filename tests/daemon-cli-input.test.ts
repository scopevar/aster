import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

// Exercise the real helper in another Node process: an unhandled stdin error
// must fail the proof rather than kill this test runner. Only the CLI is a fixture.
await test("CLI input failures reject the call without an unhandled stream error", async () => {
  const root = resolve(".runtime/test-results");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "cli-input-"));
  try {
    const child = join(directory, "child.mjs");
    await writeFile(child, "console.error('EARLY_EXIT'); process.exit(7);");
    const harness = join(directory, "harness.mjs");
    await writeFile(
      harness,
      `import { daemonCli } from ${JSON.stringify(new URL("./helpers/daemon-cli.ts", import.meta.url).href)};
try {
  await daemonCli(${JSON.stringify(directory)}, 'models', { payload: 'x'.repeat(2 * 1024 * 1024) }, undefined, { executable: process.execPath, script: ${JSON.stringify(child)} });
  throw Error('unexpected success');
} catch (error) {
  if (!String(error).includes('EARLY_EXIT')) throw error;
  console.log('EXPECTED_CLI_FAILURE');
}`,
    );
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", harness],
      { timeout: 15000, windowsHide: true },
    );
    assert.match(result.stdout, /EXPECTED_CLI_FAILURE/);
    assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

await test("CLI rejects unsent input despite zero exit, spawn failure and invalid serialization", async () => {
  const root = resolve(".runtime/test-results");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "cli-input-errors-"));
  try {
    const child = join(directory, "child.mjs");
    await writeFile(child, "console.log('{}'); process.exit(0);");
    const harness = join(directory, "harness.mjs");
    await writeFile(
      harness,
      `import assert from 'node:assert/strict';
import { daemonCli } from ${JSON.stringify(new URL("./helpers/daemon-cli.ts", import.meta.url).href)};
const launch = { executable: process.execPath, script: ${JSON.stringify(child)} };
await assert.rejects(daemonCli(${JSON.stringify(directory)}, 'models', { payload: 'x'.repeat(2 * 1024 * 1024) }, undefined, launch), /CLI input channel failed/);
await assert.rejects(daemonCli(${JSON.stringify(directory)}, 'models', {}, undefined, { ...launch, executable: ${JSON.stringify(join(directory, "missing-executable"))} }), { code: 'ENOENT' });
await assert.rejects(daemonCli(${JSON.stringify(directory)}, 'models', { value: 1n }, undefined, launch), TypeError);
console.log('EXPECTED_INPUT_ERRORS');`,
    );
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", harness],
      { timeout: 15000, windowsHide: true },
    );
    assert.match(result.stdout, /EXPECTED_INPUT_ERRORS/);
    assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
