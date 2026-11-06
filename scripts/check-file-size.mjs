#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_SOURCE_LINES = 500;
const MAX_TEST_LINES = 800;
const BASELINE_PATH = "config/file-size-baseline.txt";
const HEADER = [
  "# Existing files grandfathered by the file-size ratchet.",
  "# The list may only shrink; split files before exceeding the current budget.",
  "# Format: repo-relative path<TAB>max counted lines",
  "",
].join("\n");

export function repositoryFiles(root, paths) {
  return execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...paths,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter((file) => file && existsSync(path.join(root, file)));
}

function checkedFiles(root) {
  return repositoryFiles(root, ["src", "packages", "tests"]).filter((file) =>
    /\.(?:ts|tsx|mts|cts)$/u.test(file),
  );
}

function isTestFile(file) {
  return (
    file.startsWith("tests/") || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)
  );
}

export function countLines(file) {
  const content = readFileSync(file, "utf8");
  if (content.length === 0) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

function readBaseline(root) {
  const baseline = new Map();
  try {
    const content = readFileSync(path.join(root, BASELINE_PATH), "utf8");
    for (const line of content.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const [file, count] = line.split("\t");
      if (!file || !count || !Number.isInteger(Number(count))) {
        throw new Error(`Malformed ${BASELINE_PATH} entry: ${line}`);
      }
      baseline.set(file, Number(count));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return baseline;
}

function budgetFor(file) {
  return isTestFile(file) ? MAX_TEST_LINES : MAX_SOURCE_LINES;
}

export function checkFileSizes(
  root = process.cwd(),
  baseline = readBaseline(root),
  files,
) {
  const violations = [];
  const current = new Map();
  for (const file of files ?? checkedFiles(root)) {
    const count = countLines(path.join(root, file));
    const previous = baseline.get(file);
    const cap = previous ?? budgetFor(file);
    current.set(file, count);
    if (count > cap) {
      violations.push({
        file,
        count,
        cap,
        reason: previous ? "grew" : "budget",
      });
    }
  }
  return { violations, baseline, current };
}

function baselineText(entries) {
  return (
    HEADER +
    [...entries]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, count]) => `${file}\t${count}`)
      .join("\n") +
    (entries.size ? "\n" : "")
  );
}

export function writeBaseline(root = process.cwd()) {
  const { current } = checkFileSizes(root, new Map());
  const entries = new Map(
    [...current.entries()].filter(([file, count]) => count > budgetFor(file)),
  );
  return baselineText(entries);
}

function hasBaseline(root) {
  return existsSync(path.join(root, BASELINE_PATH));
}

export function main(root = process.cwd(), args = process.argv.slice(2)) {
  const init = args.includes("--init-baseline");
  const write = args.includes("--write-baseline");
  if (init && hasBaseline(root)) {
    console.error(
      `${BASELINE_PATH} already exists; --init-baseline is one-time only. Split the file instead.`,
    );
    return 1;
  }
  if (!init && !write && !hasBaseline(root)) {
    console.error(
      `${BASELINE_PATH} is missing; run --init-baseline once, then commit the baseline.`,
    );
    return 1;
  }

  const { violations, baseline, current } = checkFileSizes(root);
  if (init) {
    const entries = new Map(
      [...current.entries()].filter(([file, count]) => count > budgetFor(file)),
    );
    writeFileSync(path.join(root, BASELINE_PATH), baselineText(entries));
    console.log(`Initialized ${BASELINE_PATH} with ${entries.size} file(s).`);
    return 0;
  }

  if (write) {
    const added = violations.filter(({ reason }) => reason === "budget");
    const grew = violations.filter(({ reason }) => reason === "grew");
    if (added.length > 0 || grew.length > 0) {
      console.error(
        "Refusing to write a larger baseline; split these files first:",
      );
      for (const { file, count, cap, reason } of violations) {
        const detail =
          reason === "grew"
            ? `grew from ${cap}`
            : `exceeds the ${cap}-line budget`;
        console.error(`  ${file}: ${count} lines; ${detail}.`);
      }
      return 1;
    }
    const entries = new Map(
      [...baseline.entries()].filter(([file]) => current.has(file)),
    );
    writeFileSync(path.join(root, BASELINE_PATH), baselineText(entries));
    console.log(
      `Wrote ${BASELINE_PATH}: ${entries.size} grandfathered file(s).`,
    );
    return 0;
  }

  if (violations.length === 0) {
    console.log(
      `File-size check OK: ${baseline.size} grandfathered file(s); new source files must stay <= ${MAX_SOURCE_LINES} lines and tests <= ${MAX_TEST_LINES}.`,
    );
    return 0;
  }
  console.error("File-size ratchet violations:");
  for (const { file, count, cap, reason } of violations) {
    const detail =
      reason === "grew"
        ? `grew from the grandfathered limit of ${cap}`
        : `exceeds the ${cap}-line budget`;
    console.error(`  ${file}: ${count} lines; ${detail}. Split the file.`);
  }
  return 1;
}

if (import.meta.main) process.exitCode = main();
