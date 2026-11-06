import mammoth from "mammoth";
import sharp from "sharp";
import { AppError } from "../shared/core.js";
import {
  type OfficeOperation,
  type OfficeResult,
  type officeImageSchema,
} from "../shared/files/office.js";
import type { z } from "zod";
import { inspectOfficeArchive } from "./office-archive.js";
import { officeContent } from "./office-content.js";

/** Called only inside the bounded document worker. Conversion never receives a filesystem path. */
export async function readWord(
  bytes: Buffer,
  operation: OfficeOperation,
): Promise<OfficeResult> {
  if (!operation.action.startsWith("word."))
    throw new AppError("invalid_input", "此操作需要表格文件。");
  const names = await inspectOfficeArchive(bytes);
  if (!names.has("word/document.xml") || !names.has("[Content_Types].xml"))
    throw new AppError("invalid_input", "文件不是有效的 DOCX 文档。");
  const images: z.infer<typeof officeImageSchema>[] = [];
  const warnings = new Set<string>();
  if ([...names].some((name) => /vbaProject|embeddings\//i.test(name)))
    warnings.add("嵌入对象和宏不会执行，也不会显示其内部内容。");
  let imageBytes = 0;
  const converted = await mammoth.convertToHtml(
    { buffer: bytes },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      ignoreEmptyParagraphs: false,
      convertImage: mammoth.images.imgElement(async (image) => {
        if (images.length >= 32)
          throw new AppError("capacity", "DOCX 超过 32 张图片，请拆分文件。");
        const index = images.length;
        const record: z.infer<typeof officeImageSchema> = {
          index,
          data: null,
          error: null,
        };
        images.push(record);
        try {
          if (
            ![
              "image/png",
              "image/jpeg",
              "image/gif",
              "image/webp",
              "image/tiff",
              "image/bmp",
            ].includes(image.contentType)
          )
            throw new Error("Unsupported image");
          const buffer = await image.readAsBuffer();
          if (buffer.byteLength > 8 * 1024 * 1024)
            throw new Error("Image exceeds limit");
          const data = (
            await sharp(buffer, {
              limitInputPixels: 16_000_000,
              animated: false,
              failOn: "warning",
            })
              .rotate()
              .resize({
                width: 1800,
                height: 1800,
                fit: "inside",
                withoutEnlargement: true,
              })
              .png()
              .toBuffer()
          ).toString("base64");
          if (
            data.length > 4 * 1024 * 1024 ||
            imageBytes + data.length > 12 * 1024 * 1024
          )
            throw new Error("Output image exceeds limit");
          record.data = data;
          imageBytes += data.length;
        } catch {
          record.error =
            "图片格式不受支持、已损坏或超过大小限制。原文件仍保留。";
          warnings.add(`图片 ${index + 1} 无法显示。`);
        }
        return { src: `office-image:${index}` };
      }),
    },
  );
  // Mammoth may recover from individual XML/image failures. Expose all reported losses.
  for (const message of converted.messages)
    warnings.add(message.message.slice(0, 1000));
  const content = officeContent(converted.value);
  for (const warning of content.warnings) warnings.add(warning);
  if (warnings.size > 100)
    throw new AppError(
      "capacity",
      "DOCX 有超过 100 项转换问题，无法可靠预览。",
    );
  const common = { warnings: [...warnings] };
  switch (operation.action) {
    case "word.info":
      return {
        action: operation.action,
        characters: content.text.length,
        images: images.length,
        ...common,
      };
    case "word.preview":
      return {
        action: operation.action,
        nodes: content.nodes,
        images,
        ...common,
      };
    case "word.text": {
      if (operation.offset > content.text.length)
        throw new AppError("invalid_input", "文字起始位置超过文档长度。");
      const text = content.text.slice(
        operation.offset,
        operation.offset + operation.length,
      );
      const end = operation.offset + text.length;
      return {
        action: operation.action,
        offset: operation.offset,
        text,
        total: content.text.length,
        next: end < content.text.length ? end : null,
        ...common,
      };
    }
    case "word.image": {
      const image = images[operation.index];
      if (!image)
        throw new AppError(
          "invalid_input",
          `文档中不存在这张图片。共有 ${images.length} 张图片，index 从 0 开始${images.length ? `，有效范围为 0–${images.length - 1}` : ""}。`,
        );
      return { action: operation.action, image, ...common };
    }
    default:
      throw new AppError("invalid_input", "此操作需要表格文件。");
  }
}
