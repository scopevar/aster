import { createHash } from "node:crypto";
import { extname } from "node:path";
import sharp from "sharp";
import type { ReadInput, ReadResult } from "../shared/files/reads.js";
import { AppError } from "../shared/core.js";

export function readText(text: string, input: ReadInput): ReadResult {
  if (input.offset > text.length)
    throw new AppError("invalid_input", "读取位置超过文本长度。");
  let end = Math.min(text.length, input.offset + input.limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? ""))
    end += end === input.offset + 1 ? 1 : -1;
  return {
    type: "text",
    path: input.path,
    text: text.slice(input.offset, end),
    size: Buffer.byteLength(text),
    hash: createHash("sha256").update(text).digest("hex"),
    nextOffset: end < text.length ? end : null,
  };
}

/** Binary documents stay in the VM; only text and actual images enter model context. */
export async function readContent(
  bytes: Buffer,
  input: ReadInput,
  shellPath: string,
): Promise<ReadResult> {
  const metadata = {
    path: input.path,
    size: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
  if (
    [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(
      extname(input.path).toLowerCase(),
    )
  ) {
    const data = await sharp(bytes, { limitInputPixels: 25_000_000 })
      .rotate()
      .resize({
        width: 1600,
        height: 1600,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    if (data.length > 3 * 1024 * 1024)
      throw new AppError("capacity", "图片过大，请在沙箱中裁剪或缩小后读取。");
    return {
      type: "image",
      ...metadata,
      mimeType: "image/png",
      data: data.toString("base64"),
    };
  }
  let text: string | undefined;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Non-UTF-8 files are processed with Python in the sandbox.
  }
  if (text !== undefined && !text.includes("\0")) return readText(text, input);
  return {
    type: "file",
    ...metadata,
    shellPath,
    detail:
      "Use shell with Python to process this file. Read generated text/images with read.",
  };
}
