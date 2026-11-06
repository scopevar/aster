import type { PDFPageProxy } from "pdfjs-dist";
import type { Canvas } from "@napi-rs/canvas";
import { z } from "zod";

export async function renderNativePdf(
  page: PDFPageProxy,
  canvas: Canvas,
  viewport: ReturnType<PDFPageProxy["getViewport"]>,
  annotationMode: number,
): Promise<void> {
  // [Platform]: PDF.js supports Node canvas at runtime but declares DOM-only parameters; keep the native boundary explicit and validate the returned task.
  const task: unknown = Reflect.apply(page.render, page, [
    {
      canvas,
      canvasContext: canvas.getContext("2d"),
      viewport,
      annotationMode,
    },
  ]);
  const result = z.object({ promise: z.instanceof(Promise) }).parse(task);
  await result.promise;
}
