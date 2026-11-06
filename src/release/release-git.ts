import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runCommand } from "./command.js";

const packageSchema = z
  .record(z.string(), z.unknown())
  .and(z.object({ version: z.string() }));

export function git(root: string, args: string[]) {
  return runCommand("git", args, { cwd: root });
}

export async function readPackage(root: string) {
  const text = await readFile(join(root, "package.json"), "utf8");
  const data = packageSchema.parse(JSON.parse(text) as unknown);
  return { text, data };
}

export async function writeVersion(root: string, version: string) {
  const { data } = await readPackage(root);
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ ...data, version }, null, 2)}\n`,
  );
}

export async function requireCleanTree(root: string) {
  if (
    await git(root, [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--",
      ".",
    ])
  )
    throw new Error("发布需要干净的工作区，请先提交修改。");
}
