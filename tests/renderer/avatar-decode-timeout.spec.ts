import { randomUUID } from "node:crypto";
import { envelopeSchema } from "../../src/shared/commands.js";
import { test, expect } from "../helpers/renderer-app.js";

const gif = Buffer.from(
  "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64",
);

// Contract: a decode that outlives 10 seconds reports a timeout, and its late bitmap is closed instead of applied.
// Failure: the editor keeps waiting, or a late result replaces the cleared preview and leaks the bitmap.
// Gap: the Electron acceptance waited 11 real seconds for this renderer-only timer.
test("slow avatar decode times out and discards the late bitmap", async ({
  page,
  renderer,
}, info) => {
  renderer.store().execute(
    envelopeSchema.parse({
      id: randomUUID(),
      command: { type: "bot.create", name: "头像超时", description: "" },
    }),
  );
  await page.clock.install();
  await renderer.open();
  await page.locator(".bot-item", { hasText: "头像超时" }).click();
  await page.locator(".conversation-title").click();
  await page
    .getByRole("button", { name: "编辑 Bot 头像", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "头像编辑器" });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({
      width: colorScheme === "dark" ? 760 : 1050,
      height: 650,
    });
    await expect(editor).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: info.outputPath(`avatar-${colorScheme}.png`),
      animations: "disabled",
    });
  }
  await editor.getByRole("tab", { name: "上传", exact: true }).click();
  // Decoding finishes only when the test releases it, after the timeout fired.
  await page.evaluate(() => {
    const close = ImageBitmap.prototype.close;
    Object.defineProperty(ImageBitmap.prototype, "close", {
      configurable: true,
      value: function (this: ImageBitmap) {
        document.body.dataset.avatarBitmapClosed = "true";
        close.call(this);
      },
    });
    const original = window.createImageBitmap.bind(window);
    Object.defineProperty(window, "createImageBitmap", {
      configurable: true,
      value: async (source: ImageBitmapSource) => {
        await new Promise((resolve) =>
          document.addEventListener("release-decode", resolve, { once: true }),
        );
        return original(source);
      },
    });
  });
  const chooser = page.waitForEvent("filechooser");
  await editor.getByRole("button", { name: "选择本地图片" }).click();
  await (
    await chooser
  ).setFiles({ name: "slow.gif", mimeType: "image/gif", buffer: gif });
  await page.clock.fastForward(10_000);
  await expect(editor.getByRole("alert")).toContainText("超过 10 秒");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("release-decode")),
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-avatar-bitmap-closed",
    "true",
  );
  await expect(editor.getByRole("img", { name: /头像裁剪预览/ })).toHaveCount(
    0,
  );
  await expect(editor.getByRole("alert")).toContainText("超过 10 秒");
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "编辑 Bot 头像", exact: true }),
  ).toBeFocused();
  expect(renderer.unhandled).toEqual([]);
});
