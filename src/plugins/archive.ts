import type { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import { resolve } from "node:path";
import yauzl from "yauzl";
import { AppError } from "../shared/core.js";
import { pluginPath } from "./files.js";

/** Read a bounded immutable snapshot without writing archive paths to disk. */
export async function readPluginArchive(bytes: Buffer, signal: AbortSignal) {
  signal.throwIfAborted();
  if (bytes.length > 16 * 1024 * 1024)
    throw new AppError("capacity", "插件压缩包超过 16 MiB。");
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, result) => {
        if (error) reject(new AppError("invalid_input", "插件 ZIP 格式无效。"));
        else if (result) resolve(result);
        else reject(new AppError("invalid_input", "插件 ZIP 格式无效。"));
      },
    );
  });
  const files: Record<string, string> = Object.create(null);
  const paths = new Map<string, boolean>();
  let size = 0;
  let stream: Readable | undefined;
  try {
    await new Promise<void>((done, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        stream?.destroy();
        zip.close();
        reject(
          error instanceof AppError || signal.aborted
            ? error
            : new AppError("invalid_input", "插件 ZIP 内容损坏。"),
        );
      };
      const abort = () => fail(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const cleanup = () => signal.removeEventListener("abort", abort);
      zip.on("error", fail);
      zip.on("close", cleanup);
      zip.on("end", () => {
        cleanup();
        if (!settled) {
          settled = true;
          done();
        }
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        const read = async () => {
          signal.throwIfAborted();
          const directory = entry.fileName.endsWith("/");
          const path = directory ? entry.fileName.slice(0, -1) : entry.fileName;
          pluginPath(resolve("plugin-archive"), path);
          const parts = path.split("/");
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (
            parts.length > 16 ||
            parts.some((part) => [".git", "node_modules"].includes(part)) ||
            paths.has(path) ||
            entry.isEncrypted() ||
            (mode !== 0 && mode !== (directory ? 0o040000 : 0o100000))
          )
            throw new AppError(
              "invalid_input",
              "插件 ZIP 含重复、加密或不支持的文件路径。",
            );
          for (const [other, isDirectory] of paths)
            if (
              (!isDirectory && path.startsWith(`${other}/`)) ||
              (!directory && other.startsWith(`${path}/`))
            )
              throw new AppError(
                "invalid_input",
                "插件 ZIP 的文件和目录冲突。",
              );
          paths.set(path, directory);
          if (
            paths.size > 1024 ||
            (!directory && Object.keys(files).length >= 512) ||
            entry.uncompressedSize > 2 * 1024 * 1024 ||
            size + entry.uncompressedSize > 8 * 1024 * 1024
          )
            throw new AppError(
              "capacity",
              "插件解包内容超过文件数量或大小限制。",
            );
          if (directory) {
            if (entry.uncompressedSize !== 0)
              throw new AppError(
                "invalid_input",
                "插件 ZIP 目录包含文件内容。",
              );
          } else {
            stream = await new Promise<Readable>((resolve, reject) => {
              zip.openReadStream(entry, (error, value) => {
                if (settled || signal.aborted) {
                  value?.destroy();
                  reject(signal.reason ?? new Error("ZIP closed"));
                } else if (error) reject(error);
                else if (value) resolve(value);
                else reject(new Error("Missing ZIP stream"));
              });
            });
            signal.throwIfAborted();
            let checksum = 0,
              length = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
              signal.throwIfAborted();
              if (!(chunk instanceof Uint8Array))
                throw new Error("Invalid ZIP chunk");
              length += chunk.byteLength;
              size += chunk.byteLength;
              if (length > 2 * 1024 * 1024 || size > 8 * 1024 * 1024)
                throw new AppError(
                  "capacity",
                  "插件实际解包内容超过大小限制。",
                );
              checksum = crc32(chunk, checksum);
              chunks.push(Buffer.from(chunk));
            }
            if (length !== entry.uncompressedSize || checksum !== entry.crc32)
              throw new AppError("invalid_input", "插件 ZIP 文件校验失败。");
            files[path] = Buffer.concat(chunks).toString("base64");
          }
          if (!settled) zip.readEntry();
        };
        void read().catch(fail);
      });
      if (signal.aborted) abort();
      else zip.readEntry();
    });
    return files;
  } finally {
    stream?.destroy();
    zip.close();
  }
}
