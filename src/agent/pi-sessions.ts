import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { AppError } from "../shared/core.js";

const identity = /^pi:v1:([a-f0-9]{64}):([A-Za-z0-9_-]+)$/;
const cancelledTurn = "aster.cancelled-turn";
const checkpointSchema = z.object({ leafId: z.string().nullable() });
const runStart = "aster.run-start";
const runSchema = z.object({ runId: z.string() });

/** Continuations and group contributions share the checkpoint of their run. */
export function piContextCheckpoint(manager: SessionManager, runId?: string) {
  if (runId) {
    const previous = manager
      .getBranch()
      .find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === runStart &&
          runSchema.parse(entry.data).runId === runId,
      );
    if (previous) return previous.parentId;
  }
  const leafId = manager.getLeafId();
  if (runId) manager.appendCustomEntry(runStart, { runId });
  return leafId;
}

/** Custom entries persist the active branch without adding text to model context. */
export function restoreCancelledContext(
  manager: SessionManager,
  retain: boolean,
  isRunCancelled?: (runId: string) => boolean,
) {
  if (retain) return;
  const leaf = manager.getLeafEntry();
  let leafId: string | null;
  if (leaf?.type === "custom" && leaf.customType === cancelledTurn) {
    leafId = checkpointSchema.parse(leaf.data).leafId;
  } else {
    // A group member may have finished its contribution before the user
    // cancelled another member. The parent run decides whether it is retained.
    const previous = manager
      .getBranch()
      .findLast(
        (entry) => entry.type === "custom" && entry.customType === runStart,
      );
    if (
      previous?.type !== "custom" ||
      !isRunCancelled?.(runSchema.parse(previous.data).runId)
    )
      return;
    leafId = previous.parentId;
  }
  if (leafId) manager.branch(leafId);
  else manager.resetLeaf();
  manager.appendCustomEntry("aster.context-restored");
}

export function markCancelledContext(
  manager: SessionManager,
  leafId: string | null,
) {
  manager.appendCustomEntry(cancelledTurn, { leafId });
}

function canonical(path: string) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
export function isPiSession(id: string) {
  return identity.test(id);
}
function scopeKey(workspace: string, conversationId: string) {
  return createHash("sha256")
    .update(JSON.stringify([canonical(workspace), conversationId]))
    .digest("hex");
}
async function safeDirectory(path: string) {
  await mkdir(path, { recursive: true });
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    canonical(await realpath(path)) !== canonical(path)
  )
    throw new AppError("unauthorized", "Pi 会话目录不允许链接或跨范围访问。");
}
function parsed(id: string) {
  const match = identity.exec(id);
  if (!match) return null;
  const name = Buffer.from(match[2]!, "base64url").toString("utf8");
  if (basename(name) !== name || !/^[a-zA-Z0-9_.-]+\.jsonl$/.test(name))
    throw new AppError("unauthorized", "Pi 会话标识无效。");
  return { key: match[1]!, name };
}
export async function piSessionExists(id: string, workspace: string) {
  const ref = parsed(id);
  if (!ref) return false;
  try {
    await lstat(join(workspace, "pi-sessions", ref.key, ref.name));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
export async function openPiSession(
  workspace: string,
  conversationId: string,
  threadId: string | null,
) {
  const key = scopeKey(workspace, conversationId);
  const root = join(workspace, "pi-sessions"),
    directory = join(root, key);
  await safeDirectory(workspace);
  await safeDirectory(root);
  await safeDirectory(directory);
  const ref = threadId ? parsed(threadId) : null;
  let manager: SessionManager;
  if (ref) {
    if (ref.key !== key)
      throw new AppError("unauthorized", "Pi 会话不属于当前账户、聊天或成员。");
    const file = join(directory, ref.name),
      stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      canonical(await realpath(file)) !== canonical(file)
    )
      throw new AppError("unauthorized", "Pi 会话文件越出授权范围。");
    manager = SessionManager.open(file, directory);
    if (canonical(manager.getCwd()) !== canonical(workspace))
      throw new AppError("unauthorized", "Pi 会话工作区不匹配。");
  } else manager = SessionManager.create(workspace, directory);
  const file = manager.getSessionFile();
  if (!file) throw Error("Pi session file missing");
  return {
    manager,
    threadId: `pi:v1:${key}:${Buffer.from(basename(file)).toString("base64url")}`,
  };
}

/** Deletes only app-owned Pi JSONL; legacy/global provider files are intentionally untouched. */
export async function cleanPiSessions(
  workspace: string,
  threadIds: readonly string[] | undefined,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const root = join(workspace, "pi-sessions");
  try {
    await lstat(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  await safeDirectory(root);
  const refs = threadIds?.map(parsed).filter((ref) => ref !== null);
  const groups = refs
    ? [...new Set(refs.map((ref) => ref.key))]
    : await readdir(root);
  for (const key of groups) {
    signal.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new AppError("unauthorized", "Pi 会话范围无效。");
    const dir = join(root, key);
    await safeDirectory(dir);
    const names = refs
      ? refs.filter((ref) => ref.key === key).map((ref) => ref.name)
      : await readdir(dir);
    for (const name of names) {
      signal.throwIfAborted();
      if (!/^[a-zA-Z0-9_.-]+\.jsonl$/.test(name))
        throw new AppError("unauthorized", "Pi 会话文件无效。");
      const file = join(dir, name);
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new AppError("unauthorized", "不能清理链接会话。");
        await unlink(file);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
    }
  }
}
