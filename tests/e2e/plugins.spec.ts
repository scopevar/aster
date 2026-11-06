import { test, expect, _electron as electron } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDesktopWorker as startWorker } from "../helpers/desktop-worker.js";
import type { Agent } from "../../src/chat/agent.js";
import { data, snapshotOf } from "./ipc-result.js";
import { z } from "zod";
import { newBot } from "./new-conversation.js";

test("sandboxed local manager imports a plugin, persists skills, approves real MCP and revokes it", async ({}, info) => {
  const directory = await mkdtemp(join(tmpdir(), "aster-plugins-e2e-"));
  const root = await mkdtemp(join(tmpdir(), "aster-plugins-e2e-package-")),
    effects = join(directory, "effects");
  await mkdir(join(root, ".cursor-plugin"), { recursive: true });
  await mkdir(join(root, "skills", "echo"), { recursive: true });
  await writeFile(
    join(root, ".cursor-plugin", "plugin.json"),
    JSON.stringify({
      name: "calendar-fixture",
      description: "本地验收插件",
      mcpServers: {
        local: {
          command: process.execPath,
          args: ["${CURSOR_PLUGIN_ROOT}/server.mjs"],
          env: { EFFECT_PATH: "${EFFECT_PATH}" },
        },
      },
    }),
  );
  await writeFile(
    join(root, "skills", "echo", "SKILL.md"),
    "---\nname: echo\ndescription: 用于验收\n---\n通过插件 MCP 回声工具返回用户输入。",
  );
  await writeFile(
    join(root, "server.mjs"),
    await readFile(new URL("../fixtures/plugin-mcp.mjs", import.meta.url)),
  );
  const agent: Agent = {
    check: async () => ({ accountType: null, detail: "local fixture" }),
    async run(input) {
      if (!input.toolAccess) throw Error("Missing scoped tools");
      const request = async (body: unknown) => {
        const response = await fetch(
          `http://127.0.0.1:${input.toolAccess!.port}/tools/plugins`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${input.toolAccess!.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: input.signal,
          },
        );
        const value: unknown = await response.json();
        if (!response.ok) throw Error(JSON.stringify(value));
        return value;
      };
      const catalog = z
        .object({
          tools: z.array(
            z.object({
              pluginId: z.uuid(),
              server: z.string(),
              name: z.string(),
            }),
          ),
          errors: z.array(z.unknown()),
        })
        .parse(
          await request({ callId: "list", operation: { action: "list" } }),
        );
      const tool = catalog.tools[0];
      if (!tool || catalog.errors.length) throw Error("MCP discovery failed");
      const result = await request({
        callId: "echo",
        operation: {
          action: "call",
          pluginId: tool.pluginId,
          server: tool.server,
          tool: tool.name,
          arguments: { text: input.text },
        },
      });
      input.onEvent({
        type: "text",
        itemId: "result",
        text: JSON.stringify(result),
        complete: true,
      });
      return { status: "completed", error: null };
    },
  };
  const worker = await startWorker(directory, { agent });
  const env: Record<string, string> = { ASTER_DATA_DIR: directory };
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && key !== "ASTER_DATA_DIR") env[key] = value;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [resolve(".")], env });
    const page = await app.firstWindow();
    await newBot(page);
    await page.getByLabel("名称", { exact: true }).fill("插件验收");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    const snapshot = snapshotOf(
      await page.evaluate(() => window.aster.snapshot({})),
    );
    const bot = snapshot.bots.find((bot) => bot.name === "插件验收");
    expect(bot).toBeTruthy();
    if (!bot) throw Error("Missing Bot");
    const invalid = await page.evaluate(
      ({ botId, root }) =>
        Reflect.apply(window.aster.plugins, window.aster, [
          { action: "prepare", botId, root, epoch: crypto.randomUUID() },
        ]),
      { botId: bot.id, root },
    );
    expect(invalid.success).toBe(false);
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [root],
      });
    }, root);
    await page.getByRole("button", { name: "本地市场", exact: true }).click();
    const market = page.getByRole("dialog", { name: "本地市场", exact: true });
    await market.getByRole("tab", { name: "插件", exact: true }).click();
    await market
      .getByRole("button", { name: "导入本地插件", exact: true })
      .click();
    await expect(
      market.getByText("导入预览：calendar-fixture", { exact: true }),
    ).toBeVisible();
    await market.getByLabel("EFFECT_PATH", { exact: true }).fill(effects);
    const enable = market.getByRole("checkbox", { name: /启用 MCP/ });
    await enable.press("Space");
    await expect(enable).toBeChecked();
    await market.getByRole("button", { name: "确认导入", exact: true }).click();
    await expect(
      market.getByText("插件已导入；技能可在技能目录中读取。", { exact: true }),
    ).toBeVisible();
    await expect(
      market.getByRole("button", {
        name: "打开技能 calendar-fixture:echo",
        exact: true,
      }),
    ).toBeVisible();
    const installed = data(
      await page.evaluate(
        (botId) => window.aster.plugins({ action: "list", botId }),
        bot.id,
      ),
    );
    expect(installed.plugins[0]?.enabled).toBe(true);
    expect(JSON.stringify(installed)).not.toContain(effects);
    await page.screenshot({
      path: info.outputPath("plugins-installed.png"),
      scale: "css",
    });
    await page.keyboard.press("Escape");
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("PLUGIN_APPROVAL_OK");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const approval = page.getByRole("region", {
      name: "插件工具审批",
      exact: true,
    });
    await expect(
      approval.getByRole("button", { name: "允许一次", exact: true }),
    ).toBeVisible();
    await expect(access(effects)).rejects.toThrow();
    await page.screenshot({
      path: info.outputPath("plugins-approval.png"),
      scale: "css",
    });
    await approval
      .getByRole("button", { name: "允许一次", exact: true })
      .click();
    await expect(approval).toContainText("已返回");
    await expect(
      page.getByRole("button", { name: "停止回复", exact: true }),
    ).toHaveCount(0);
    expect((await readFile(effects, "utf8")).trim().split("\n")).toHaveLength(
      1,
    );
    await page.getByRole("button", { name: "本地市场", exact: true }).click();
    await market.getByRole("tab", { name: "插件", exact: true }).click();
    await market.getByRole("button", { name: "关闭 MCP", exact: true }).click();
    await expect(
      market.getByText("MCP：已关闭", { exact: true }),
    ).toBeVisible();
    await market.getByRole("button", { name: "卸载", exact: true }).click();
    await expect(
      market.getByText("该 Bot 尚未安装插件。", { exact: true }),
    ).toBeVisible();
    expect(
      data(
        await page.evaluate(
          (botId) => window.aster.skillCatalog([botId]),
          bot.id,
        ),
      ),
    ).toEqual([]);
  } finally {
    await app?.close();
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
