import { createHash } from "node:crypto";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { AppError } from "../shared/core.js";
import { maxAttachmentBytes } from "../shared/files/attachments.js";
import type { FileRequest, FileResult } from "../shared/files/files.js";

const canonical = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
async function target(root: string, path: string) {
  if (
    /[\u0000-\u001f:]/.test(path) ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes("..")
  )
    throw new AppError(
      "unauthorized",
      "路径必须位于授权目录内，不能包含穿越或备用数据流。",
    );
  const candidate = resolve(root, path || ".");
  const child = relative(canonical(root), canonical(candidate));
  if (
    isAbsolute(child) ||
    child === ".." ||
    child.startsWith("..\\") ||
    child.startsWith("../")
  )
    throw new AppError("unauthorized", "路径超出了授权目录。");
  if (
    canonical(await realpath(root)) !== canonical(root) ||
    canonical(await realpath(candidate)) !== canonical(candidate)
  )
    throw new AppError("unauthorized", "授权路径已被重定向，不能读取链接。");
  return candidate;
}

/** A read-only OS adapter. Callers must check live grant ownership again after awaiting it. */
export async function readGrantedPath(
  root: string,
  operation: Extract<FileRequest["operation"], { action: "read" | "list" }>,
  signal: AbortSignal,
): Promise<FileResult> {
  signal.throwIfAborted();
  const path = await target(root, operation.path);
  const stat = await lstat(path);
  if (stat.isSymbolicLink())
    throw new AppError("unauthorized", "不能读取链接。");
  if (operation.action === "list") {
    if (!stat.isDirectory())
      throw new AppError("invalid_input", "这个路径不是目录。");
    const directory = await opendir(path);
    const entries: Extract<FileResult, { action: "list" }>["entries"] = [];
    let count = 0;
    let more = false;
    // for-await closes the directory handle on normal completion, errors and early break.
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (count++ < operation.offset) continue;
      if (entries.length === 100) {
        more = true;
        break;
      }
      entries.push({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? "blocked"
          : entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : "blocked",
      });
    }
    if (more && operation.offset >= 9900)
      throw new AppError(
        "capacity",
        "目录超过 10000 项，请使用更具体的子目录。",
      );
    await target(root, operation.path);
    const current = await lstat(path);
    if (
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      current.mtimeMs !== stat.mtimeMs ||
      current.isSymbolicLink()
    )
      throw new AppError("conflict", "列举期间目录已改变，请重新列举。");
    signal.throwIfAborted();
    return {
      action: "list",
      entries,
      nextOffset: more ? operation.offset + entries.length : null,
    };
  }
  const bytes = await readGrantedBytes(root, operation.path, signal);
  let content: string;
  let length: number;
  let end: number;
  if (operation.encoding === "utf8") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new AppError(
        "invalid_input",
        "文件不是 UTF-8 文本，请选择 document 解析文档或 base64 读取原始字节。",
      );
    }
    if (text.includes("\0"))
      throw new AppError(
        "invalid_input",
        "文件包含二进制内容，请使用 document 或 base64。",
      );
    length = text.length;
    end = Math.min(length, operation.offset + 64 * 1024);
    if (end < length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
    content = text.slice(operation.offset, end);
  } else {
    length = bytes.length;
    end = Math.min(length, operation.offset + 64 * 1024);
    content = bytes.subarray(operation.offset, end).toString("base64");
  }
  if (operation.offset > length)
    throw new AppError("invalid_input", "读取位置超出了文件长度。");
  return {
    action: "read",
    encoding: operation.encoding,
    content,
    size: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex"),
    nextOffset: end < length ? end : null,
  };
}

/** Returns a bounded verified snapshot; it does not grant authority to parse or publish it. */
export async function readGrantedBytes(
  root: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  const path = await target(root, relativePath);
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
    throw new AppError("unauthorized", "只能读取单一归属的普通文件。");
  if (stat.size > maxAttachmentBytes)
    throw new AppError("capacity", "单个文件最多 25 MiB。");
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      opened.size !== stat.size ||
      opened.nlink !== 1
    )
      throw new AppError("conflict", "文件在打开时已改变，请重新读取。");
    await target(root, relativePath);
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    const finished = await handle.stat();
    const current = await lstat(await target(root, relativePath));
    if (
      size !== stat.size ||
      finished.mtimeMs !== opened.mtimeMs ||
      finished.ctimeMs !== opened.ctimeMs ||
      current.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.isSymbolicLink() ||
      current.nlink !== 1
    )
      throw new AppError("conflict", "读取期间文件已改变，未返回混合内容。");
    signal.throwIfAborted();
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}
