import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runNode } from "./dev-process.mjs";

const environmentGroups = {
  media: new Set(["documents.test.ts", "video.test.ts"]),
  sandbox: new Set([
    "microsandbox.test.ts",
    "microsandbox-preparation.test.ts",
  ]),
};
const environmentTests = new Set(
  Object.values(environmentGroups).flatMap((files) => [...files]),
);
const buildFreeTests = new Set(["guards.test.ts"]);
// These modules need no build artifacts, database, network server or real process.
// Unclassified tests stay in integration so new coverage is never silently omitted.
const unitTests = new Set([
  "command-queue.test.ts",
  "desktop-agent-connections.test.ts",
  "ipc-contracts.test.ts",
  "message-markdown.test.ts",
  "packaged-startup.test.ts",
  "provider-presets.test.ts",
  "stream-buffer.test.ts",
  "template-edit-cache.test.ts",
  "web-policy.test.ts",
  "worker-dispatch.test.ts",
]);
const group = process.argv[2] ?? "core";
const option = process.argv[3];
if (process.argv.length > 4 || (option && option !== "--list"))
  throw new Error("Usage: node scripts/test.mjs <group> [--list]");
const entries = await readdir("tests", { withFileTypes: true });
const allTests = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => entry.name)
  .sort();

let selected;
switch (group) {
  case "unit":
    selected = allTests.filter((file) => unitTests.has(file));
    break;
  case "integration":
  case "core":
    selected = allTests.filter(
      (file) =>
        !environmentTests.has(file) &&
        !buildFreeTests.has(file) &&
        (group === "core" || !unitTests.has(file)),
    );
    break;
  case "guards":
    selected = allTests.filter((file) => buildFreeTests.has(file));
    break;
  case "media":
  case "sandbox":
    selected = allTests.filter((file) => environmentGroups[group].has(file));
    break;
  case "environment":
    selected = allTests.filter((file) => environmentTests.has(file));
    break;
  case "all":
    selected = allTests;
    break;
  default:
    throw new Error(`Unknown test group: ${group}`);
}

// An empty --test file list would let Node discover unrelated suites.
if (selected.length === 0)
  throw new Error(`No tests found for group: ${group}`);
if (option === "--list") {
  console.log(selected.map((file) => join("tests", file)).join("\n"));
  process.exit(0);
}

// Integration includes real diagnostic/credential entry tests that need Electron.
// Prepare once before workers start; guard and environment-only groups stay independent.
if (group === "integration" || group === "core" || group === "all") {
  const code = await runNode(process.cwd(), [
    fileURLToPath(new URL("./prepare-electron.mjs", import.meta.url)),
  ]);
  if (code !== 0) process.exit(code);
}

const child = spawn(
  process.execPath,
  [
    fileURLToPath(import.meta.resolve("tsx/cli")),
    "--test",
    // Integration suites also spawn real workers and OS credential helpers.
    `--test-concurrency=${Math.min(availableParallelism(), 4)}`,
    ...selected.map((file) => join("tests", file)),
  ],
  { stdio: "inherit", env: process.env },
);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (value, signal) => {
    if (signal) console.error(`测试进程被 ${signal} 终止。`);
    resolve(value ?? 1);
  });
});
process.exitCode = code;
