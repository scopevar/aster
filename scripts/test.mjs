import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
const group = process.argv[2] ?? "core";
const entries = await readdir("tests", { withFileTypes: true });
const allTests = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => entry.name)
  .sort();

let selected;
switch (group) {
  case "core":
    selected = allTests.filter(
      (file) => !environmentTests.has(file) && !buildFreeTests.has(file),
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
