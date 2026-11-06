#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { repositoryFiles } from "./check-file-size.mjs";

const MAX_CHARS = 12_000;

export function agentsFiles(root = process.cwd()) {
  return repositoryFiles(root, ["AGENTS.md", "**/AGENTS.md"]).filter(
    (file) => path.basename(file) === "AGENTS.md",
  );
}

export const trackedAgentsFiles = agentsFiles;

export function checkAgents(root = process.cwd(), agents = agentsFiles(root)) {
  const problems = [];
  if (agents.length === 0) {
    problems.push(
      "No AGENTS.md files found; refusing to report a successful check.",
    );
  }
  for (const file of agents) {
    const chars = readFileSync(path.join(root, file), "utf8").length;
    if (chars > MAX_CHARS) {
      problems.push(
        `${file}: ${chars} chars exceeds ${MAX_CHARS}. Move subsystem rules to a scoped AGENTS.md.`,
      );
    }
  }

  return problems;
}

export function main(root = process.cwd()) {
  const problems = checkAgents(root);
  if (problems.length === 0) {
    console.log(
      `AGENTS check OK: AGENTS.md and scoped rules within ${MAX_CHARS} chars.`,
    );
    return 0;
  }
  console.error("AGENTS check failed:");
  for (const problem of problems) console.error(`  ${problem}`);
  return 1;
}

if (import.meta.main) process.exitCode = main();
