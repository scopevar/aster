import { test, expect } from "../helpers/renderer-app.js";
import { newBot } from "../e2e/new-conversation.js";
import { envelopeSchema } from "../../src/shared/commands.js";
import { agentConnectionsStatusSchema } from "../../src/shared/agent-connections.js";

const connections = agentConnectionsStatusSchema.parse({
  revision: "1",
  config: {
    defaultAgent: "gemini",
    connections: [
      {
        id: "gemini",
        enabled: true,
        provider: "google",
        model: "gemini-3.8-flash",
        auth: "environment",
        apiKeyEnv: "GEMINI_API_KEY",
      },
    ],
  },
  path: "agents.json",
  override: null,
  active: "gemini",
  notice: "",
});

// Contract: the model field aligns with the other fields and the dialog fits without scrolling.
// Failure: an unused second grid column halves the model field and wraps its selected label.
// Gap: the existing minimum-window check used no configured models and only checked visibility.
// Boundary: the built renderer owns layout and picker interaction; only Main's model status is replaced.
for (const colorScheme of ["light", "dark"] as const) {
  for (const size of [
    { width: 760, height: 550 },
    { width: 1314, height: 963 },
  ]) {
    test(`create Bot model field fills the form in ${colorScheme} at ${size.width}px`, async ({
      renderer,
    }, info) => {
      const page = await renderer.open({
        colorScheme,
        size,
        handlers: { agentConnections: () => connections },
      });
      await expect(
        page
          .getByRole("region", { name: "开始使用 Aster" })
          .getByRole("button", { name: "创建助手", exact: true }),
      ).toBeEnabled();
      await newBot(page);
      const dialog = page.getByRole("dialog", {
        name: "创建新 Bot",
        exact: true,
      });
      const name = dialog.getByLabel("名称", { exact: true });
      await name.fill("研发助手");
      const model = dialog.getByRole("button", { name: /Bot 供应商$/ });
      await expect(model).toBeEnabled();
      await model.click();
      const option = page.getByRole("option", {
        name: "gemini · gemini-3.8-flash",
        exact: true,
      });
      await option.click();
      await expect(option).toHaveCount(0);
      await expect(model).toContainText("gemini · gemini-3.8-flash");
      await page.screenshot({
        path: info.outputPath("create-bot-selected.png"),
        animations: "disabled",
      });

      const nameBox = await name.boundingBox();
      const modelBox = await model.boundingBox();
      if (!nameBox || !modelBox) throw Error("Missing create Bot field bounds");
      expect.soft(Math.abs(modelBox.x - nameBox.x)).toBeLessThanOrEqual(1);
      expect
        .soft(Math.abs(modelBox.width - nameBox.width))
        .toBeLessThanOrEqual(1);
      expect(
        await model
          .getByText("gemini · gemini-3.8-flash", { exact: true })
          .evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return new Set(
              Array.from(range.getClientRects(), (rect) => rect.top),
            ).size;
          }),
      ).toBe(1);
      await expect(dialog.locator(":scope > header")).toBeInViewport({
        ratio: 1,
      });
      await expect(
        dialog.getByRole("button", { name: "创建 Bot", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      expect(
        await dialog
          .locator(".create-bot-form")
          .evaluate((form) => form.scrollHeight <= form.clientHeight + 1),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);

      await model.click();
      await expect(option).toHaveAttribute("aria-selected", "true");
      await expect(option).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: info.outputPath("create-bot-picker.png"),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(option).toHaveCount(0);
      await expect(model).toBeFocused();
      await expect(dialog).toBeVisible();
      expect(renderer.unhandled).toEqual([]);
    });
  }
}

// The shared overlay owns all dismissal paths while a real form submission is pending.
// Delaying only the bridge response exposes accidental Escape/backdrop/shortcut dismissal.
test("pending Bot creation keeps the modal open until acknowledgement", async ({
  renderer,
}) => {
  const store = renderer.store();
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const page = await renderer.open({
    handlers: {
      command: async (request) => {
        await pending;
        return store.execute(envelopeSchema.parse(request));
      },
    },
  });
  try {
    await newBot(page);
    const dialog = page.getByRole("dialog", {
      name: "创建新 Bot",
      exact: true,
    });
    await dialog.getByLabel("名称", { exact: true }).fill("等待确认");
    await dialog.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "正在确认…" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "关闭弹窗" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 100);
    await page.keyboard.press("Control+k");
    await expect(dialog).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "搜索", exact: true }),
    ).toHaveCount(0);
    release();
    await expect(dialog).toHaveCount(0);
    expect(store.views.snapshot({}).bots.map((bot) => bot.name)).toEqual([
      "等待确认",
    ]);
    expect(renderer.unhandled).toEqual([]);
  } finally {
    release();
  }
});
