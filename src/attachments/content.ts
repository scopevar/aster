import { createHash } from "node:crypto";
import { extname } from "node:path";
import { imageSize } from "image-size";
import { AppError } from "../shared/core.js";
import {
  maxAttachmentBytes,
  type Attachment,
} from "../shared/files/attachments.js";

const mediaByExtension: Readonly<
  Record<string, { kind: "audio" | "video"; mime: Attachment["mime"] }>
> = {
  ".wav": { kind: "audio", mime: "audio/wav" },
  ".mp3": { kind: "audio", mime: "audio/mpeg" },
  ".ogg": { kind: "audio", mime: "audio/ogg" },
  ".m4a": { kind: "audio", mime: "audio/mp4" },
  ".mp4": { kind: "video", mime: "video/mp4" },
  ".webm": { kind: "video", mime: "video/webm" },
};
function confirmedMedia(extension: string, data: Uint8Array) {
  const spec = mediaByExtension[extension];
  if (!spec) return null;
  const head = Buffer.from(data.subarray(0, 16));
  const text = (start: number, end: number) =>
    head.subarray(start, end).toString("ascii");
  const magic =
    extension === ".wav"
      ? text(0, 4) === "RIFF" && text(8, 12) === "WAVE"
      : extension === ".mp3"
        ? text(0, 3) === "ID3" ||
          (head.length >= 2 &&
            head.readUInt8(0) === 0xff &&
            (head.readUInt8(1) & 0xe0) === 0xe0)
        : extension === ".ogg"
          ? text(0, 4) === "OggS"
          : extension === ".m4a" || extension === ".mp4"
            ? text(4, 8) === "ftyp"
            : extension === ".webm"
              ? head.length >= 4 &&
                head.readUInt8(0) === 0x1a &&
                head.readUInt8(1) === 0x45 &&
                head.readUInt8(2) === 0xdf &&
                head.readUInt8(3) === 0xa3
              : false;
  if (!magic)
    throw new AppError(
      "invalid_input",
      "无法确认这是可播放的音频或视频，未当作已理解的内容。",
    );
  return spec;
}
const textExtensions = new Set([
  ".txt",
  ".md",
  ".json",
  ".log",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".html",
  ".css",
  ".xml",
  ".yaml",
  ".yml",
  ".sql",
]);
export function inspectAttachment(
  name: string,
  data: Uint8Array,
): Pick<Attachment, "size" | "kind" | "mime" | "hash"> {
  if (data.byteLength > maxAttachmentBytes)
    throw new AppError("capacity", "单个附件最多 25 MiB。");
  const base = {
    size: data.byteLength,
    hash: createHash("sha256").update(data).digest("hex"),
  };
  const extension = extname(name).toLowerCase();
  if (extension === ".docx" || extension === ".xlsx") {
    if (
      !Buffer.from(data.subarray(0, 4)).equals(Buffer.from([0x50, 0x4b, 3, 4]))
    )
      throw new AppError(
        "invalid_input",
        "文件缺少有效 Office 压缩结构。请检查格式。",
      );
    return {
      ...base,
      kind: extension === ".docx" ? "docx" : "table",
      mime:
        extension === ".docx"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }
  if (extension === ".xls") {
    if (
      !Buffer.from(data.subarray(0, 8)).equals(
        Buffer.from("d0cf11e0a1b11ae1", "hex"),
      )
    )
      throw new AppError(
        "invalid_input",
        "文件缺少有效 XLS 文件头。请检查格式。",
      );
    return { ...base, kind: "table", mime: "application/vnd.ms-excel" };
  }
  if (extension === ".pdf") {
    if (!Buffer.from(data.subarray(0, 1024)).includes(Buffer.from("%PDF-")))
      throw new AppError(
        "invalid_input",
        "文件缺少有效 PDF 标记，请检查文件格式。",
      );
    return { ...base, kind: "pdf", mime: "application/pdf" };
  }
  if (
    textExtensions.has(extension) ||
    extension === ".csv" ||
    extension === ".tsv"
  ) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (text.includes("\u0000")) throw new Error("Binary text");
    } catch {
      throw new AppError(
        "invalid_input",
        "文本附件必须是有效 UTF-8 文本，不能包含二进制空字符。",
      );
    }
    return extension === ".csv" || extension === ".tsv"
      ? {
          ...base,
          kind: "table",
          mime: extension === ".csv" ? "text/csv" : "text/tab-separated-values",
        }
      : { ...base, kind: "text", mime: "text/plain" };
  }
  const media = confirmedMedia(extension, data);
  if (media) return { ...base, ...media };
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension))
    throw new AppError(
      "unavailable",
      "当前支持 PDF、DOCX、XLSX/XLS/CSV/TSV、UTF-8 文本、PNG/JPEG/WebP 图片，以及 WAV/MP3/OGG/M4A/MP4/WebM 音视频；该文件类型的内容解析尚未接入。",
    );
  try {
    // Buffer views keep malformed JPEG scanning linear; bound header inspection independently of file size.
    const size = imageSize(
      Buffer.from(
        data.buffer,
        data.byteOffset,
        Math.min(data.byteLength, 1024 * 1024),
      ),
    );
    if (
      size.width < 1 ||
      size.height < 1 ||
      size.width * size.height > 20_000_000
    )
      throw new Error("Pixel limit");
    const mime =
      size.type === "png"
        ? "image/png"
        : size.type === "jpg"
          ? "image/jpeg"
          : size.type === "webp"
            ? "image/webp"
            : null;
    if (!mime) throw new Error("Unsupported signature");
    return { ...base, kind: "image", mime };
  } catch {
    throw new AppError(
      "invalid_input",
      "图片头无效或像素超过 2,000 万，请换用有效图片。",
    );
  }
}
