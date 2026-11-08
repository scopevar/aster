import { AppError } from "../../src/shared/core.js";
import {
  agentConnectionsRequestSchema,
  type AgentConnectionsStatus,
} from "../../src/shared/agent-connections.js";
import { test, expect } from "../helpers/renderer-app.js";

// Owner: real settings components at the Main contract. Backend tests own
// model context; this checks discoverability, confirmed saves and failed saves.
test("cancelled-context preference saves from General settings and keeps its value on failure", async ({
  renderer,
}, info) => {
  let status: AgentConnectionsStatus = {
    revision: "0",
    config: { defaultAgent: "", connections: [] },
    path: "pi-models.json",
    active: "",
    override: null,
    notice: "",
  };
  let fail = true;
  let finishSave: (() => void) | undefined;
  const page = await renderer.open({
    size: { width: 1314, height: 963 },
    handlers: {
      agentConnections: async (input) => {
        const request = agentConnectionsRequestSchema.parse(input);
        if (request.action !== "save") return status;
        if (fail) throw new AppError("unavailable", "设置保存失败，请重试。");
        await new Promise<void>((resolve) => {
          finishSave = resolve;
        });
        status = { ...status, config: request.config, revision: "1" };
        return status;
      },
    },
  });
  const releaseSave = async () => {
    await expect.poll(() => finishSave !== undefined).toBe(true);
    finishSave?.();
    finishSave = undefined;
  };
  try {
    await page.getByRole("button", { name: /^应用菜单/ }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    const settings = page.getByRole("region", { name: "设置", exact: true });
    const section = settings.getByRole("region", { name: "对话", exact: true });
    const toggle = section.getByRole("switch", {
      name: "取消后保留本轮上下文",
    });
    await expect(toggle).toBeChecked();
    await toggle.press("Space");
    await expect(section.getByRole("alert")).toContainText("设置保存失败");
    await expect(toggle).toBeChecked();
    await page.screenshot({
      path: info.outputPath("save-failed.png"),
      animations: "disabled",
    });
    fail = false;
    await toggle.press("Space");
    await expect(toggle).toHaveAttribute("aria-readonly", "true");
    await expect(toggle).toBeChecked();
    await toggle.press("Space");
    await expect(toggle).toBeChecked();
    await releaseSave();
    await expect(toggle).not.toBeChecked();
    await expect(toggle).not.toHaveAttribute("aria-readonly", "true");
    await expect(section.getByRole("alert")).toHaveCount(0);
    await settings
      .getByRole("button", { name: "模型与连接", exact: true })
      .click();
    await settings.getByRole("button", { name: "通用", exact: true }).click();
    await expect(toggle).not.toBeChecked();

    // Save/error/pending behavior is covered above. The visual matrix only
    // checks layout; repeating the same save in every theme adds no coverage.
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        colorScheme,
      );
      for (const size of [
        { width: 1314, height: 963 },
        { width: 760, height: 550 },
      ]) {
        await page.setViewportSize(size);
        await section.scrollIntoViewIfNeeded();
        await expect(section).toBeInViewport({ ratio: 1 });
        await expect(section.locator(".settings-switch")).toBeInViewport({
          ratio: 1,
        });
        expect(
          await section.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`context-off-${colorScheme}-${size.width}.png`),
          animations: "disabled",
        });
      }
    }
    await toggle.press("Space");
    await expect(toggle).toHaveAttribute("aria-readonly", "true");
    await releaseSave();
    await expect(toggle).toBeChecked();
    await page.screenshot({
      path: info.outputPath("context-on-dark-760.png"),
      animations: "disabled",
    });
    const search = settings.getByRole("searchbox", { name: "搜索设置分类" });
    await search.fill("上下文");
    await expect(
      settings.getByRole("button", { name: "通用", exact: true }),
    ).toBeVisible();
    expect(renderer.unhandled).toEqual([]);
  } finally {
    finishSave?.();
  }
});
