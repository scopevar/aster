import { createHash } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { AppError } from "../shared/core.js";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function assetSize(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new AppError("unauthorized", "脚本环境资源不能是链接或特殊文件。");
    return info.size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

export async function readVerifiedAsset(path: string, expected: string) {
  if ((await assetSize(path)) === null) return null;
  const bytes = await readFile(path);
  if (hash(bytes) !== expected)
    throw new AppError(
      "unavailable",
      "脚本环境资源完整性校验失败；请保留诊断后重新准备。",
    );
  return bytes;
}

/** One preparation owner writes persistent partial files; only verified bytes are published. */
export async function downloadScriptAsset(
  asset: { url: string; path: string; sha256: string; limit: number },
  signal: AbortSignal,
  progress: (bytes: number, total: number | undefined) => void = () => {},
) {
  signal.throwIfAborted();
  const cached = await readVerifiedAsset(asset.path, asset.sha256);
  if (cached) return cached;
  const partial = `${asset.path}.part`;
  let offset = (await assetSize(partial)) ?? 0;
  if (offset > asset.limit)
    throw new AppError("capacity", "脚本环境资源超过下载上限。");
  if (offset && hash(await readFile(partial)) === asset.sha256) {
    await rename(partial, asset.path);
    return readFile(asset.path);
  }
  const request = () =>
    fetch(asset.url, {
      headers: {
        "Accept-Encoding": "identity",
        ...(offset ? { Range: `bytes=${offset}-` } : {}),
      },
      signal,
    });
  let response = await request();
  if (response.status === 416 && offset) {
    await response.body?.cancel();
    await unlink(partial);
    offset = 0;
    response = await request();
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new AppError(
      "unavailable",
      `脚本环境资源下载失败（HTTP ${response.status}），已保留下载进度。`,
    );
  }
  const reader = response.body.getReader();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    let total: number | undefined;
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        response.headers.get("content-range") ?? "",
      );
      if (
        !range ||
        Number(range[1]) !== offset ||
        Number(range[2]) < offset ||
        Number(range[2]) >= Number(range[3])
      )
        throw new AppError("unavailable", "资源服务器返回了无效的续传范围。");
      total = Number(range[3]);
    } else if (response.status === 200) {
      // A server may ignore Range. Replace the partial file instead of appending duplicate bytes.
      offset = 0;
      const length = response.headers.get("content-length");
      if (length !== null) total = Number(length);
    } else {
      throw new AppError("unavailable", "资源服务器返回了无效的下载响应。");
    }
    if (
      total !== undefined &&
      (!Number.isSafeInteger(total) || total < 0 || total > asset.limit)
    )
      throw new AppError("capacity", "脚本环境资源超过下载上限。");
    file = await open(partial, offset ? "a" : "w", 0o600);
    let size = offset;
    let reportedAt = 0;
    progress(size, total);
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > asset.limit)
        throw new AppError("capacity", "脚本环境资源超过下载上限。");
      await file.writeFile(part.value);
      if (Date.now() - reportedAt >= 500) {
        reportedAt = Date.now();
        progress(size, total);
      }
    }
    await file.close();
    file = undefined;
    const bytes = await readFile(partial);
    if (hash(bytes) !== asset.sha256) {
      await unlink(partial);
      throw new AppError(
        "unavailable",
        "脚本环境资源下载校验失败，未使用该文件。",
      );
    }
    signal.throwIfAborted();
    await rename(partial, asset.path);
    progress(size, total);
    return bytes;
  } finally {
    await file?.close();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
