import { test, expect } from "../helpers/desktop-test.js";
import { openDesktop } from "../helpers/local-desktop.js";
import { newBot } from "./new-conversation.js";
import { data } from "./ipc-result.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templatePayloadSchema } from "../../src/shared/templates/templates.js";

test("native template dialogs export only selected content and import a new local Bot with paused tasks", async ({
  desktop,
}, info) => {
  const outside = await mkdtemp(join(tmpdir(), "aster-template-files-"));
  try {
    const app = await desktop.launch();
    const page = await openDesktop(app);
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("文件模板");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    const first = data(await page.evaluate(() => window.aster.snapshot({})));
    if (!first.changed || !first.snapshot.bots[0]) throw Error("Missing Bot");
    const sourceId = first.snapshot.bots[0].id;
    data(
      await page.evaluate(
        (botId) =>
          window.aster.command({
            id: crypto.randomUUID(),
            command: {
              type: "skill.save",
              id: crypto.randomUUID(),
              botId,
              revision: 0,
              name: "文件技能",
              description: "guide",
              body: "Use ./input.txt",
            },
          }),
        sourceId,
      ),
    );
    data(
      await page.evaluate(
        (botId) =>
          window.aster.command({
            id: crypto.randomUUID(),
            command: {
              type: "routine.save",
              id: crypto.randomUUID(),
              botId,
              revision: 0,
              name: "文件任务",
              prompt: "check ./input.txt",
              schedule: { kind: "webhook" },
            },
          }),
        sourceId,
      ),
    );
    await page.getByRole("button", { name: "模板操作", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "管理本地模板", exact: true })
      .click();
    const manager = page.getByRole("dialog", { name: "本地模板", exact: true });
    await manager.getByText("包含技能", { exact: true }).click();
    await expect(
      manager.getByRole("checkbox", { name: "包含技能", exact: true }),
    ).toBeChecked();
    await manager.getByText("包含任务", { exact: true }).click();
    await expect(
      manager.getByRole("checkbox", { name: "包含任务", exact: true }),
    ).toBeChecked();
    await manager
      .getByRole("button", { name: "创建本地模板", exact: true })
      .click();
    await expect(manager.getByLabel("模板名称", { exact: true })).toHaveValue(
      "文件模板",
    );
    await manager.getByText("配置、说明和头像", { exact: true }).click();
    await expect(
      manager.getByRole("checkbox", { name: "配置、说明和头像", exact: true }),
    ).toBeChecked();
    await manager.getByText("技能：文件技能", { exact: true }).click();
    await expect(
      manager.getByRole("checkbox", { name: "技能：文件技能", exact: true }),
    ).toBeChecked();
    await manager.getByText("任务：文件任务", { exact: true }).click();
    await expect(
      manager.getByRole("checkbox", { name: "任务：文件任务", exact: true }),
    ).toBeChecked();
    const file = join(outside, "template.json");
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, file);
    await manager
      .getByRole("button", { name: "导出模板文件", exact: true })
      .click();
    await expect(manager.getByRole("status")).toContainText("模板文件已导出");
    const payload = templatePayloadSchema.parse(
      JSON.parse(await readFile(file, "utf8")),
    );
    expect(payload.skills.map((skill) => skill.name)).toEqual(["文件技能"]);
    expect(payload.routines.map((routine) => routine.name)).toEqual([
      "文件任务",
    ]);
    expect(JSON.stringify(payload)).not.toMatch(
      /botId|connectionId|keyHash|directory_grants|accessToken/,
    );
    await expect(manager.locator(":scope > header")).toBeInViewport({
      ratio: 1,
    });
    expect(
      await manager.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("local-template-export.png"),
    });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, file);
    await page.keyboard.press("Escape");
    await expect(manager).toHaveCount(0);
    await page.getByRole("button", { name: "本地市场", exact: true }).click();
    const market = page.getByRole("dialog", { name: "本地市场", exact: true });
    await market.getByRole("tab", { name: "模板", exact: true }).click();
    await expect(
      market.getByRole("article", { name: "文件模板", exact: true }),
    ).toBeVisible();
    await market
      .getByRole("button", { name: "导入模板文件", exact: true })
      .click();
    await manager
      .getByRole("button", { name: "导入模板文件", exact: true })
      .click();
    await expect(
      manager.getByRole("region", { name: "模板导入预览" }),
    ).toBeVisible();
    await manager
      .getByRole("button", { name: "确认导入为新 Bot", exact: true })
      .click();
    await expect(manager).toHaveCount(0);
    await expect(market).toHaveCount(0);
    const imported = data(await page.evaluate(() => window.aster.snapshot({})));
    if (!imported.changed) throw Error("Missing snapshot");
    expect(imported.snapshot.bots).toHaveLength(2);
    const bot = imported.snapshot.bots.find((item) => item.id !== sourceId);
    if (!bot) throw Error("Missing imported Bot");
    const routines = data(
      await page.evaluate((botId) => window.aster.routines({ botId }), bot.id),
    );
    expect(routines.routines[0]?.state).toBe("paused");
    await page.reload();
    await page.getByRole("button", { name: "本地市场", exact: true }).click();
    await expect(
      market.getByRole("article", { name: "文件模板", exact: true }),
    ).toHaveCount(2);
    // Rejected files cannot create another Bot or carry a hidden credential field.
    await writeFile(
      file,
      JSON.stringify({ ...payload, apiKey: "private-file-canary" }),
    );
    const result = await page.evaluate(() =>
      window.aster.templateFile({ action: "open" }),
    );
    expect(result.success).toBe(false);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
