import { randomUUID } from "node:crypto";
import { AppError, idSchema } from "../../src/shared/core.js";
import { envelopeSchema } from "../../src/shared/commands.js";
import type { Store } from "../../src/storage/store.js";
import { test, expect, type Handlers } from "../helpers/renderer-app.js";
import { selectSetting } from "../helpers/settings-controls.js";

// Owner: the built renderer and real local Store. The market must stay reachable
// without a selected chat, expose imported content, and keep plugins scoped to the chosen Bot.
// Existing chat-only plugin and template tests did not protect this navigation.
function localHandlers(store: Store): Handlers {
  return {
    templates: (query) => {
      if (query.kind === "local")
        return {
          kind: "local",
          data: store.templateOperations.localTemplates(),
        };
      if (query.kind === "draft")
        return {
          kind: "draft",
          data: store.templateOperations.templateDraft(query.id),
        };
      throw new AppError("unavailable", "This test does not export files.");
    },
    plugins: (request) => {
      if (request.action !== "list")
        throw new AppError(
          "unavailable",
          "This test only reads installed plugins.",
        );
      return {
        plugins: store.plugins.list([request.botId]),
        preview: null,
        notice: "",
      };
    },
  };
}

test("an empty local market is reachable from navigation and offers local import and Bot creation", async ({
  renderer,
}, info) => {
  const page = await renderer.open({
    size: { width: 900, height: 650 },
    handlers: localHandlers(renderer.store()),
  });
  const entry = page.getByRole("button", { name: "本地市场", exact: true });
  const activeNavigation = page.getByRole("button", {
    name: "会话",
    exact: true,
  });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator(":root")).toHaveAttribute(
      "data-theme",
      colorScheme,
    );
    const edges = await page.locator(".app").evaluate((element) => {
      const main = element.querySelector(".main-page");
      if (!main) throw Error("Missing main content");
      const outer = element.getBoundingClientRect();
      const content = main.getBoundingClientRect();
      return {
        left: content.left,
        right: content.right,
        bottom: content.bottom,
        innerLeft: outer.left + element.clientLeft,
        innerRight: outer.left + element.clientLeft + element.clientWidth,
        innerBottom: outer.top + element.clientTop + element.clientHeight,
        outerLeft: outer.left,
        outerBottom: outer.bottom,
      };
    });
    // Content should fill the client area rather than leaving a dark gutter at the edges.
    expect(edges.left).toBeCloseTo(edges.innerLeft, 0);
    expect(edges.right).toBeCloseTo(edges.innerRight, 0);
    expect(edges.bottom).toBeCloseTo(edges.innerBottom, 0);
    if (colorScheme === "dark") {
      expect(edges.left).toBeCloseTo(edges.outerLeft, 0);
      expect(edges.bottom).toBeCloseTo(edges.outerBottom, 0);
    }
    await activeNavigation.blur();
    await page.mouse.move(450, 350);
    await page.screenshot({
      path: info.outputPath("navigation-" + colorScheme + ".png"),
      animations: "disabled",
    });
    await activeNavigation.hover();
    await page.screenshot({
      path: info.outputPath("navigation-" + colorScheme + "-hover.png"),
      animations: "disabled",
    });
    await page.mouse.move(450, 350);
    await activeNavigation.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.screenshot({
      path: info.outputPath("navigation-" + colorScheme + "-focus.png"),
      animations: "disabled",
    });
    await activeNavigation.blur();
    await page.mouse.move(450, 350);
    await expect(
      page.getByRole("region", { name: "开始使用 Aster" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "搜索会话和操作" }),
    ).toHaveCount(0);
  }
  await entry.click();
  const market = page.getByRole("dialog", { name: "本地市场", exact: true });
  const close = market.getByRole("button", { name: "关闭弹窗", exact: true });
  await page.mouse.move(0, 0);
  const background = await close.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await close.hover();
  await expect
    .poll(() =>
      close.evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .not.toBe(background);
  await page.screenshot({ path: info.outputPath("market-close-hover.png") });
  await close.click();
  await expect(market).toHaveCount(0);
  await expect(entry).toBeFocused();
  await entry.click();
  await expect(market.getByRole("tab")).toHaveCount(3);
  await expect(
    market.getByText("还没有本地 Bot", { exact: true }),
  ).toBeVisible();
  await market.getByRole("tab", { name: "模板", exact: true }).click();
  await expect(
    market.getByText("还没有本地模板", { exact: true }),
  ).toBeVisible();
  await market
    .getByRole("button", { name: "导入模板文件", exact: true })
    .click();
  const templates = page.getByRole("dialog", { name: "本地模板", exact: true });
  await expect(
    templates.getByRole("button", { name: "导入模板文件", exact: true }),
  ).toBeVisible();
  const closeTemplate = templates.getByRole("button", {
    name: "关闭弹窗",
    exact: true,
  });
  await closeTemplate.hover();
  await closeTemplate.click();
  await expect(templates).toHaveCount(0);
  await expect(market).toBeVisible();
  await market.getByRole("tab", { name: "插件", exact: true }).click();
  await expect(
    market.getByText("先创建 Bot，再导入插件。", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("market-empty.png") });
  await market.getByRole("button", { name: "新建 Bot", exact: true }).click();
  await expect(market).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "创建新 Bot", exact: true }),
  ).toBeVisible();
  expect(renderer.unhandled).toEqual([]);
});

test("local Bots, installed plugins and templates can be browsed, searched and reopened", async ({
  renderer,
}, info) => {
  const store = renderer.store();
  const create = (name: string, description: string) =>
    idSchema.parse(
      store.execute(
        envelopeSchema.parse({
          id: randomUUID(),
          command: { type: "bot.create", name, description },
        }),
      ).id,
    );
  const writer = create("写作助手", "整理文案与笔记");
  create("代码助手", "解释 TypeScript");
  const draft = store.execute(
    envelopeSchema.parse({
      id: randomUUID(),
      command: {
        type: "template.create",
        botId: writer,
        includeSkills: false,
        includeRoutines: false,
      },
    }),
  );
  store.plugins.install(
    writer,
    randomUUID(),
    {
      name: "local-notes",
      description: "整理本地笔记",
      version: "1.0.0",
      format: "generic",
      skills: [],
      servers: {},
      variables: [],
      warnings: [],
      files: {},
    },
    {},
    false,
  );
  const page = await renderer.open({
    handlers: localHandlers(store),
    size: { width: 1100, height: 760 },
  });
  const entry = page.getByRole("button", { name: "本地市场", exact: true });
  await entry.click();
  const market = page.getByRole("dialog", { name: "本地市场", exact: true });
  await expect(market.getByRole("article")).toHaveCount(2);
  const search = market.getByRole("searchbox", {
    name: "搜索本地内容",
    exact: true,
  });
  await search.fill("typescript");
  await expect(market.getByRole("article")).toHaveCount(1);
  await expect(
    market.getByRole("article", { name: "代码助手", exact: true }),
  ).toBeVisible();
  await search.fill("");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [760, 1100]) {
      await page.setViewportSize({ width, height: width === 760 ? 550 : 760 });
      await expect(search).toBeInViewport({ ratio: 1 });
      await expect(
        market.getByRole("button", { name: "关闭弹窗", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      expect(
        await market.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath("market-" + colorScheme + "-" + width + ".png"),
      });
    }
  }
  await market.getByRole("tab", { name: "插件", exact: true }).click();
  await selectSetting(page, "安装到 Bot", "写作助手");
  await expect(
    market.getByRole("heading", {
      name: "local-notes generic · 1.0.0",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    market.getByRole("button", { name: "导入本地插件", exact: true }),
  ).toBeVisible();
  await search.fill("no-such-plugin");
  await expect(
    market.getByText("没有匹配的插件", { exact: true }),
  ).toBeVisible();
  await search.fill("");
  await selectSetting(page, "安装到 Bot", "代码助手");
  await expect(
    market.getByText("该 Bot 尚未安装插件。", { exact: true }),
  ).toBeVisible();
  await expect(market.getByText("local-notes", { exact: true })).toHaveCount(0);
  await selectSetting(page, "安装到 Bot", "写作助手");
  await expect(market.getByText("MCP：已关闭", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("market-plugins.png") });
  await market.getByRole("tab", { name: "模板", exact: true }).click();
  await expect(
    market.getByRole("article", { name: "写作助手", exact: true }),
  ).toBeVisible();
  await market
    .getByRole("button", { name: "编辑模板 写作助手", exact: true })
    .click();
  const templates = page.getByRole("dialog", { name: "本地模板", exact: true });
  await expect(templates.getByLabel("模板名称", { exact: true })).toHaveValue(
    "写作助手",
  );
  const configuration = templates.getByRole("checkbox", {
    name: "配置、说明和头像",
    exact: true,
  });
  await configuration.focus();
  await page.keyboard.press("Space");
  await expect(configuration).toBeChecked();
  await templates.getByText("配置、说明和头像", { exact: true }).click();
  await expect(configuration).not.toBeChecked();
  await templates.screenshot({
    path: info.outputPath("template-checkboxes.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(templates).toHaveCount(0);
  await expect(
    market.getByRole("tab", { name: "模板", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    market.getByRole("button", { name: "编辑模板 写作助手", exact: true }),
  ).toBeFocused();
  expect(
    store.templateOperations.templateDraft(idSchema.parse(draft.id)).payload
      .name,
  ).toBe("写作助手");
  await page.keyboard.press("Escape");
  await expect(market).toHaveCount(0);
  await entry.click();
  await market
    .getByRole("button", { name: "打开会话 写作助手", exact: true })
    .click();
  await expect(market).toHaveCount(0);
  await expect(page.locator(".conversation-title")).toContainText("写作助手");
  expect(store.snapshotSince({})?.conversations).toHaveLength(2);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.mouse.move(800, 600);
    await page.screenshot({
      path: info.outputPath("sidebar-" + colorScheme + ".png"),
      animations: "disabled",
    });
    await page.locator(".bot-item").filter({ hasText: "代码助手" }).hover();
    await page.screenshot({
      path: info.outputPath("sidebar-" + colorScheme + "-hover.png"),
      animations: "disabled",
    });
  }
  expect(renderer.unhandled).toEqual([]);
});
