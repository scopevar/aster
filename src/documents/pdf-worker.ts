import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getDocument, AnnotationMode } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";
import { AppError } from "../shared/core.js";
import {
  pdfOperationSchema,
  pdfResultSchema,
  type PdfResult,
} from "../shared/files/documents.js";
import { maxAttachmentBytes } from "../shared/files/attachments.js";
import { renderNativePdf } from "./native-pdf-render.js";

const input = z
  .object({
    bytes: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength <= maxAttachmentBytes),
    operation: pdfOperationSchema,
  })
  .strict()
  .parse(workerData);
const packageRoot = dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
const resourceDirectory = (name: string) =>
  join(packageRoot, name).replaceAll("\\", "/") + "/";
const task = getDocument({
  data: input.bytes,
  enableXfa: false,
  useWorkerFetch: false,
  useSystemFonts: false,
  stopAtErrors: true,
  verbosity: 0,
  standardFontDataUrl: resourceDirectory("standard_fonts"),
  cMapUrl: resourceDirectory("cmaps"),
  wasmUrl: resourceDirectory("wasm"),
  maxImageSize: 16_000_000,
});
try {
  const doc = await task.promise;
  if (doc.numPages > 1000)
    throw new AppError("capacity", "PDF 超过 1,000 页处理上限，请拆分后上传。");
  let result: PdfResult;
  if (input.operation.action === "info")
    result = { action: "info", pages: doc.numPages };
  else {
    if (input.operation.page > doc.numPages)
      throw new AppError("invalid_input", `PDF 只有 ${doc.numPages} 页。`);
    const page = await doc.getPage(input.operation.page);
    try {
      if (input.operation.action === "text") {
        const content = await page.getTextContent();
        let text = "";
        for (const item of content.items) {
          if (!("str" in item)) continue;
          text += item.str + (item.hasEOL ? "\n" : " ");
          if (text.length > 120000)
            throw new AppError(
              "capacity",
              "本页文字超过 120,000 字符上限，未截断；请查看页面图片或拆分文件。",
            );
        }
        result = {
          action: "text",
          pages: doc.numPages,
          page: input.operation.page,
          text: text.trim(),
        };
      } else {
        const base = page.getViewport({ scale: 1 });
        if (
          ![base.width, base.height].every(
            (value) => Number.isFinite(value) && value > 0 && value <= 14400,
          )
        )
          throw new AppError("capacity", "页面尺寸超过可渲染范围。");
        const viewport = page.getViewport({
          scale: Math.min(2, 1800 / Math.max(base.width, base.height)),
        });
        const canvas = createCanvas(
          Math.max(1, Math.floor(viewport.width)),
          Math.max(1, Math.floor(viewport.height)),
        );
        await renderNativePdf(page, canvas, viewport, AnnotationMode.ENABLE);
        const png = canvas.toBuffer("image/png");
        const image = png.toString("base64");
        if (image.length > 4 * 1024 * 1024)
          throw new AppError(
            "capacity",
            "页面图片超过单次返回上限，请压缩原文件后重试。",
          );
        let ocr: Extract<PdfResult, { action: "render" }>["ocr"];
        const selectable = await page.getTextContent();
        if (
          !selectable.items.some((item) => "str" in item && item.str.trim())
        ) {
          let reader: Awaited<ReturnType<typeof createWorker>> | undefined;
          try {
            const langPath = fileURLToPath(
              new URL("./tessdata/", import.meta.url),
            );
            // Both traineddata files are copied at build time. Nothing is downloaded per page.
            reader = await createWorker("eng+chi_sim", 1, {
              langPath,
              cacheMethod: "none",
            });
            const recognized = await reader.recognize(png);
            const text = joinHanCharacters(recognized.data.text).trim();
            if (text.length > 120000)
              throw new AppError("capacity", "扫描页识别文字超过结果上限。");
            ocr = {
              status: "ready",
              language: "eng+chi_sim",
              text,
              confidence: recognized.data.confidence,
            };
          } catch {
            ocr = {
              status: "failed",
              reason: "本地文字识别未能读出扫描页，请查看原始页面图片。",
            };
          } finally {
            await reader?.terminate();
          }
        }
        result = {
          action: "render",
          pages: doc.numPages,
          page: input.operation.page,
          width: canvas.width,
          height: canvas.height,
          image,
          ...(ocr ? { ocr } : {}),
        };
      }
    } finally {
      page.cleanup();
    }
  }
  const validated = pdfResultSchema.parse(result);
  await task.destroy();
  parentPort?.postMessage({ ok: true, result: validated });
} catch (error) {
  await task.destroy();
  parentPort?.postMessage({
    ok: false,
    error:
      error instanceof AppError
        ? { code: error.code, message: error.message }
        : {
            code: "invalid_input",
            message:
              error instanceof Error && error.name === "PasswordException"
                ? "PDF 已加密，请先解密再上传。原文件仍保留。"
                : "PDF 无法解析，文件可能损坏或使用不支持的格式。原文件仍保留。",
          },
  });
} finally {
  parentPort?.close();
}

/** Tesseract inserts spaces between Han characters. Chinese words are not written that way. */
function joinHanCharacters(text: string) {
  return text.replace(
    /\p{Script=Han}(?:[ \t\u3000]+\p{Script=Han})+/gu,
    (run) => run.replace(/[ \t\u3000]+/g, ""),
  );
}
