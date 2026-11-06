import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import { AppError } from "../shared/core.js";

/** Validate every stream before a converter expands it again. No archive member is written to disk. */
export async function inspectOfficeArchive(
  bytes: Buffer,
): Promise<Set<string>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, result) => {
        if (error) reject(error);
        else if (!result)
          reject(new AppError("invalid_input", "文档压缩结构无效。"));
        else resolve(result);
      },
    );
  });
  const names = new Set<string>();
  let declared = 0,
    actual = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error);
          zip.close();
        }
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        const read = async () => {
          if (names.has(entry.fileName))
            throw new AppError(
              "invalid_input",
              "文档包含重复文件项，无法确定内容。",
            );
          names.add(entry.fileName);
          if (names.size > 2000)
            throw new AppError(
              "capacity",
              "文档压缩包超过 2,000 项，请拆分文件。",
            );
          if (entry.isEncrypted())
            throw new AppError("invalid_input", "文档已加密，请先解密后上传。");
          declared += entry.uncompressedSize;
          if (
            entry.uncompressedSize > 16 * 1024 * 1024 ||
            declared > 64 * 1024 * 1024
          )
            throw new AppError(
              "capacity",
              "文档解压后超过 64 MiB 或单项超过 16 MiB，请拆分文件。",
            );
          if (!entry.fileName.endsWith("/")) {
            const stream = await new Promise<
              NodeJS.ReadableStream & {
                destroy(): void;
                [Symbol.asyncIterator](): AsyncIterator<unknown>;
              }
            >((resolve, reject) => {
              zip.openReadStream(entry, (error, value) => {
                if (error) reject(error);
                else if (value) resolve(value);
                else reject(new Error("Missing archive stream"));
              });
            });
            let checksum = 0,
              size = 0;
            try {
              for await (const chunk of stream) {
                if (!(chunk instanceof Uint8Array))
                  throw new Error("Invalid archive chunk");
                size += chunk.byteLength;
                actual += chunk.byteLength;
                if (size > 16 * 1024 * 1024 || actual > 64 * 1024 * 1024)
                  throw new AppError("capacity", "文档实际解压大小超过限制。");
                checksum = crc32(chunk, checksum);
              }
            } finally {
              stream.destroy();
            }
            if (size !== entry.uncompressedSize || checksum !== entry.crc32)
              throw new AppError(
                "invalid_input",
                "文档压缩内容校验失败，原文件可能损坏。",
              );
          }
          if (!settled) zip.readEntry();
        };
        void read().catch(fail);
      });
      zip.readEntry();
    });
    return names;
  } finally {
    zip.close();
  }
}
