import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { AppError } from "../shared/core.js";
import { maxAttachmentBytes } from "../shared/files/attachments.js";
import type { Job, Store } from "../storage/store.js";
import { sandboxLimits } from "./protocol.js";

const canonical = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
async function directory(path: string) {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    canonical(await realpath(path)) !== canonical(path)
  )
    throw new AppError("unauthorized", "脚本目录不能包含指向其他位置的链接。");
}
export function scriptInputPath(attachment: Job["attachments"][number]) {
  const extension = extname(attachment.name).toLowerCase();
  return `/inputs/${attachment.id}${/^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".bin"}`;
}
/** Only the work subdirectory is mounted. Pi sessions and input caches stay outside it. */
export async function prepareWorkspace(
  root: string,
  store: Pick<Store, "files">,
  job: Job,
  signal: AbortSignal,
) {
  z.uuid().parse(job.botId);
  z.uuid().parse(job.id);
  await directory(root);
  const bot = join(root, job.botId);
  await directory(bot);
  const workspace = join(bot, "script-work");
  const inputsRoot = join(bot, "script-inputs");
  const inputs = join(inputsRoot, job.id);
  await directory(workspace);
  await directory(inputsRoot);
  await directory(inputs);
  let inputBytes = 0;
  for (const expected of job.attachments) {
    signal.throwIfAborted();
    const { attachment, bytes } = store.files.attachmentContent(
      job.conversationId,
      expected.id,
    );
    inputBytes += bytes.length;
    if (inputBytes > 200 * 1024 * 1024)
      throw new AppError("capacity", "本轮脚本输入超过 200 MiB。");
    if (
      attachment.hash !== expected.hash ||
      createHash("sha256").update(bytes).digest("hex") !== expected.hash
    )
      throw new AppError("unavailable", "脚本附件校验失败，未启动沙箱。");
    const path = join(inputs, scriptInputPath(attachment).split("/").at(-1)!);
    await writeFile(path, bytes, { flag: "wx", mode: 0o444 });
  }
  return { workspace, inputs };
}
export async function scriptWorkspaceQuota(
  workspace: string,
  signal: AbortSignal,
) {
  let entries = 0,
    bytes = 0;
  const measure = async (path: string): Promise<void> => {
    for (const name of await readdir(path)) {
      signal.throwIfAborted();
      if (++entries > 10000)
        throw new AppError(
          "capacity",
          "Bot 脚本工作区超过一万个文件，请整理后再运行。",
        );
      const child = join(path, name);
      const info = await lstat(child);
      if (info.isSymbolicLink())
        throw new AppError(
          "unauthorized",
          "脚本工作区包含宿主链接，未启动沙箱。",
        );
      if (info.isDirectory()) await measure(child);
      else if (info.isFile()) bytes += info.size;
      else throw new AppError("unauthorized", "脚本工作区包含特殊文件。");
      if (bytes >= sandboxLimits.workspaceMiB * 1024 * 1024)
        throw new AppError("capacity", "Bot 脚本工作区已达 512 MiB 上限。");
    }
  };
  await measure(workspace);
  const quotaMiB = Math.floor(
    sandboxLimits.workspaceMiB - bytes / (1024 * 1024),
  );
  if (quotaMiB < 1)
    throw new AppError("capacity", "Bot 脚本工作区没有剩余写入空间。");
  return quotaMiB;
}
export async function clearScriptInputs(
  root: string,
  botId: string,
  runId: string,
) {
  z.uuid().parse(botId);
  z.uuid().parse(runId);
  const parent = join(resolve(root), botId, "script-inputs");
  const target = join(parent, runId);
  try {
    await lstat(parent);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  if (
    relative(parent, target) !== runId ||
    canonical(await realpath(parent)) !== canonical(parent)
  )
    throw new AppError("unauthorized", "脚本输入清理目录超出范围。");
  await rm(target, { recursive: true, force: true });
}
export async function workPath(root: string, path: string) {
  if (isAbsolute(path) || path.includes("\\") || path.includes(":"))
    throw new AppError("invalid_input", "请使用脚本工作区内的相对路径。");
  const target = resolve(root, path);
  const local = relative(root, target);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
    throw new AppError("unauthorized", "文件不在这个 Bot 的脚本工作区。");
  let current = root;
  for (const part of local.split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new AppError("unauthorized", "不能导出链接或读取其他目录。");
  }
  if (canonical(await realpath(target)) !== canonical(target))
    throw new AppError("unauthorized", "脚本文件路径发生变化。");
  return target;
}
export async function readScriptFile(root: string, path: string) {
  const target = await workPath(root, path);
  const handle = await open(target, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxAttachmentBytes || info.nlink !== 1)
      throw new AppError("capacity", "仅能导出不超过 25 MiB 的独立普通文件。");
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs
    )
      throw new AppError("conflict", "脚本文件在导出时变化，未提交附件。");
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
export async function listScriptFiles(root: string, path: string) {
  const names = await readdir(await workPath(root, path), {
    withFileTypes: true,
  });
  if (names.length > 100)
    throw new AppError("capacity", "目录超过 100 项，请使用更具体的子目录。");
  return names.map((entry) => ({
    name: entry.name,
    kind: entry.isSymbolicLink()
      ? ("blocked" as const)
      : entry.isFile()
        ? ("file" as const)
        : entry.isDirectory()
          ? ("directory" as const)
          : ("blocked" as const),
  }));
}
