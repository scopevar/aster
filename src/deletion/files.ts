import { lstat, mkdir, realpath, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { AppError } from "../shared/core.js";
import type { DeletionPlan } from "../shared/deletions.js";

const canonical = (value: string) =>
  process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

async function checkedDirectory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    canonical(await realpath(path)) !== canonical(path)
  )
    throw new AppError("unauthorized", "清理目录指向了其他位置，未删除文件。");
}

/** Returns only a canonical direct Bot directory under the project's configured root. */
export async function ownedWorkspace(
  root: string,
  botId: string,
  create = false,
) {
  z.uuid().parse(botId);
  await checkedDirectory(root);
  const path = join(root, botId),
    scope = relative(resolve(root), resolve(path));
  if (!scope || scope.startsWith("..") || isAbsolute(scope) || scope !== botId)
    throw new AppError("unauthorized", "清理工作区范围无效。");
  try {
    await checkedDirectory(path);
  } catch (error) {
    if (!missing(error)) throw error;
    if (!create) return null;
    await mkdir(path);
    await checkedDirectory(path);
  }
  return path;
}

/** Quiesced writers are a caller precondition. Child links are unlinked, never followed by Node rm. */
export async function cleanWindowsFiles(
  root: string,
  plan: DeletionPlan,
  signal: AbortSignal,
) {
  for (const cache of plan.caches) {
    signal.throwIfAborted();
    if (cache.botId === plan.botId) continue;
    const workspace = await ownedWorkspace(root, cache.botId);
    if (!workspace) continue;
    const directory = join(workspace, "attachments");
    try {
      await checkedDirectory(directory);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    const path = join(directory, cache.fileName);
    if (relative(directory, path) !== cache.fileName)
      throw new AppError("unauthorized", "附件清理路径无效。");
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new AppError(
          "unauthorized",
          "附件缓存类型或链接已改变，未删除。",
        );
      await unlink(path);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  if (plan.botId) {
    signal.throwIfAborted();
    const workspace = await ownedWorkspace(root, plan.botId);
    if (workspace)
      await rm(workspace, { recursive: true, force: false, maxRetries: 0 });
  }
}
