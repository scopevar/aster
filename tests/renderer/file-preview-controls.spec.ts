import { randomUUID } from "node:crypto";
import { test, expect } from "../helpers/renderer-app.js";
import { sampleWord, sampleWorkbook } from "../helpers/office.js";

// The real renderer owns preview toolbars, disclosure and sheet keyboard navigation.
// Main's document results are controlled here; parser and native save behavior have separate owners.
test("file previews keep shared close controls, readable warnings and keyboard sheet selection", async ({
  renderer,
}, info) => {
  const store = renderer.store();
  const bot = store.execute({
    id: randomUUID(),
    command: { type: "bot.create", name: "文件控件", description: "" },
  });
  if (!bot.conversationId) throw Error("Missing conversation");
  const word = store.files.registerAttachment(
    {
      id: randomUUID(),
      conversationId: bot.conversationId,
      name: "preview.docx",
    },
    sampleWord("preview"),
  );
  store.files.registerAttachment(
    {
      id: randomUUID(),
      conversationId: bot.conversationId,
      name: "preview.xlsx",
    },
    sampleWorkbook("preview"),
  );
  const sheets = ["数据", "明细"].map((name, index) => ({
    name,
    index,
    rows: 1,
    columns: 1,
    hidden: false,
  }));
  const saved: string[] = [];
  const page = await renderer.open({
    size: { width: 760, height: 550 },
    handlers: {
      documentPreview: ({ operation }) => {
        if (operation.action === "word.preview")
          return {
            action: "word.preview",
            nodes: [{ kind: "text", text: "文档预览正文" }],
            images: [],
            warnings: ["文档中的外部资源未加载"],
          };
        if (operation.action === "table.info")
          return { action: "table.info", sheets, warnings: [] };
        if (operation.action === "table.range") {
          const sheet = sheets[operation.sheet];
          if (!sheet) throw Error("Unexpected sheet");
          return {
            action: "table.range",
            sheet,
            row: 1,
            column: 1,
            cells: [
              [
                {
                  address: "A1",
                  text: sheet.name + "内容",
                  value: sheet.name + "内容",
                  formula: null,
                  error: false,
                },
              ],
            ],
            warnings: [],
          };
        }
        throw Error("Unexpected document request");
      },
      cancelDocumentPreview: () => {},
      saveAttachment: ({ id }) => {
        saved.push(id);
        return true;
      },
    },
  });
  await page.locator(".bot-item").filter({ hasText: "文件控件" }).click();
  const wordTrigger = page.getByRole("button", {
    name: "预览 preview.docx",
    exact: true,
  });
  await wordTrigger.click();
  const wordDialog = page.getByRole("dialog", {
    name: "preview.docx",
    exact: true,
  });
  await expect(wordDialog.getByRole("article")).toHaveText("文档预览正文");
  const warnings = wordDialog.getByRole("button", { name: /文档读取说明/ });
  await warnings.click();
  await expect(warnings).toHaveAttribute("aria-expanded", "true");
  await expect(wordDialog.getByText("文档中的外部资源未加载")).toBeVisible();
  await wordDialog
    .getByRole("button", { name: "保存原文件", exact: true })
    .click();
  await expect.poll(() => saved).toEqual([word.id]);
  await page.screenshot({
    path: info.outputPath("word-light.png"),
    animations: "disabled",
  });
  await wordDialog
    .getByRole("button", { name: "关闭弹窗", exact: true })
    .click();
  await expect(wordDialog).toHaveCount(0);
  await expect(wordTrigger).toBeFocused();
  await page
    .getByRole("button", { name: "预览 preview.xlsx", exact: true })
    .click();
  const table = page.getByRole("dialog", { name: "preview.xlsx", exact: true });
  await expect(
    table.getByRole("gridcell", { name: "A1", exact: true }),
  ).toHaveText("数据内容");
  await table.getByRole("tab", { name: "数据", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    table.getByRole("tab", { name: "明细", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    table.getByRole("gridcell", { name: "A1", exact: true }),
  ).toHaveText("明细内容");
  await table.getByRole("button", { name: "复制选区", exact: true }).click();
  await expect.poll(() => renderer.copied.at(-1)).toBe("明细内容");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(
      table.getByRole("button", { name: "关闭弹窗", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      table.getByRole("tab", { name: "明细", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: info.outputPath(`table-${colorScheme}.png`),
      animations: "disabled",
    });
  }
  await page.keyboard.press("Escape");
  await expect(table).toHaveCount(0);
  expect(renderer.unhandled).toEqual([]);
});
