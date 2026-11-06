import { randomUUID } from "node:crypto";
import { test, expect } from "../helpers/renderer-app.js";
import { samplePdf } from "../helpers/pdf.js";

// Built PDF.js must still render and expose selectable text without host parsers.
test("PDF preview renders text and scan pages without native Canvas or OCR", async ({
  renderer,
}, info) => {
  const store = renderer.store();
  const bot = store.execute({
    id: randomUUID(),
    command: { type: "bot.create", name: "PDF audit", description: "" },
  });
  if (!bot.conversationId) throw Error("Missing conversation");
  store.files.registerAttachment(
    { id: randomUUID(), conversationId: bot.conversationId, name: "audit.pdf" },
    samplePdf("PDF_PROOF", "SCAN"),
  );
  const page = await renderer.open({
    handlers: {
      attachmentContent: ({ id, conversationId }) => {
        const file = store.files.attachmentContent(conversationId, id);
        return {
          attachment: file.attachment,
          data: Buffer.from(file.bytes).toString("base64"),
        };
      },
    },
  });
  await page.locator(".bot-item").filter({ hasText: "PDF audit" }).click();
  await page
    .getByRole("button", { name: "\u9884\u89c8 audit.pdf", exact: true })
    .click();
  const modal = page.getByRole("dialog", { name: "audit.pdf", exact: true });
  await expect(modal.locator(".textLayer")).toContainText(["PDF_PROOF", ""]);
  await expect(modal.locator(".pdf-page-status")).toHaveCount(0);
  const pixels = await modal
    .locator("canvas")
    .nth(1)
    .evaluate((canvas: HTMLCanvasElement) => {
      const data = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4)
        if (data[i]! < 20 && data[i + 1]! < 20 && data[i + 2]! > 230)
          return true;
      return false;
    });
  expect(pixels).toBe(true);
  await page.screenshot({ path: info.outputPath("pdf-preview.png") });
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  expect(renderer.unhandled).toEqual([]);
});
