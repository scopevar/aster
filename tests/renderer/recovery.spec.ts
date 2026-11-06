import { randomUUID } from "node:crypto";
import { AppError } from "../../src/shared/core.js";
import { envelopeSchema } from "../../src/shared/commands.js";
import { test, expect } from "../helpers/renderer-app.js";
import { newBot } from "../e2e/new-conversation.js";

// The real editors own recovery. Store tests cannot cover a failed read after
// acknowledgement, or a browser cache being overwritten by the next keystroke.
test("confirmed Bot creation survives a failed snapshot refresh", async ({
  renderer,
}) => {
  const store = renderer.store();
  let failNextRead = false;
  const page = await renderer.open({
    handlers: {
      command: (request) => {
        const result = store.execute(envelopeSchema.parse(request));
        if (request.command.type === "bot.create") failNextRead = true;
        return result;
      },
      snapshot: (query) => {
        if (failNextRead) {
          failNextRead = false;
          throw new AppError("unavailable", "读取暂时不可用");
        }
        const snapshot = store.snapshotSince(query);
        return snapshot
          ? {
              changed: true,
              snapshot: {
                ...snapshot,
                capabilities: { agent: "ready", detail: "", accountType: null },
              },
            }
          : { changed: false, cursor: store.cursor() };
      },
    },
  });
  await newBot(page);
  await page.getByLabel("名称", { exact: true }).fill("已确认的 Bot");
  await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "创建新 Bot", exact: true }),
  ).toHaveCount(0);
  expect(store.views.snapshot({}).bots).toHaveLength(1);
  expect(
    await page.evaluate(() => localStorage.getItem("bot-create:local")),
  ).toBeNull();
  expect(renderer.unhandled).toEqual([]);
});

test("routine acknowledgement stays confirmed when its following read fails", async ({
  renderer,
}) => {
  const store = renderer.store();
  const bot = store.execute({
    id: randomUUID(),
    command: { type: "bot.create", name: "任务恢复", description: "" },
  });
  if (!bot.id) throw Error("Missing Bot");
  const routineId = randomUUID();
  store.execute({
    id: randomUUID(),
    command: {
      type: "routine.save",
      id: routineId,
      botId: bot.id,
      revision: 0,
      name: "只执行一次",
      prompt: "test",
      schedule: { kind: "webhook" },
    },
  });
  let failReads = false,
    executions = 0;
  const page = await renderer.open({
    handlers: {
      command: (request) => {
        const result = store.execute(envelopeSchema.parse(request));
        if (request.command.type === "routine.test") {
          executions++;
          failReads = true;
        }
        return result;
      },
      routines: (query) => {
        if (failReads) throw new AppError("unavailable", "任务列表读取失败");
        return {
          ...store.routineOperations.view(query),
          webhookBase: "",
          schedulerError: null,
        };
      },
    },
  });
  await page.goto(
    `https://aster.test/routines.html?view=routines&botId=${bot.id}&routineId=${routineId}`,
  );
  await expect(page.getByLabel("任务名称", { exact: true })).toHaveValue(
    "只执行一次",
  );
  await page
    .getByRole("button", { name: "测试一次（真实执行）", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("真实测试已接受");
  await expect(page.getByRole("alert")).toContainText("任务列表读取失败");
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "{}").pending,
      `routine-editor:${bot.id}`,
    ),
  ).toBeNull();
  failReads = false;
  await expect(page.getByText("任务列表读取失败", { exact: true })).toHaveCount(
    0,
  );
  expect(executions).toBe(1);
  expect(
    store.routineOperations.view({ botId: bot.id, routineId }).events,
  ).toHaveLength(1);
  expect(renderer.unhandled).toEqual([]);
});

for (const shared of [false, true]) {
  test(`${shared ? "shared" : "Bot"} memory preserves an unreadable pending record until explicit recovery`, async ({
    renderer,
  }, info) => {
    const store = renderer.store();
    const bot = store.execute({
      id: randomUUID(),
      command: { type: "bot.create", name: "记忆恢复", description: "" },
    });
    if (!bot.id) throw Error("Missing Bot");
    const key = shared
      ? "shared-memory-editor:account:account"
      : `memory-editor:${bot.id}:bot`;
    const original = '{"pending":';
    const page = await renderer.open({
      size: { width: 900, height: 650 },
      handlers: {
        memory: (scope) => store.memoryOperations.memoryView(scope),
        sharedMemory: (scope) => store.memoryOperations.sharedMemoryView(scope),
      },
    });
    await page.evaluate(([key, raw]) => localStorage.setItem(key, raw), [
      key,
      original,
    ] as const);
    await expect(page.getByRole("button", { name: /^应用菜单/ })).toBeVisible();
    if (!shared) {
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox", { name: "搜索" }).fill("记忆恢复");
      await page.getByRole("combobox", { name: "搜索" }).press("Enter");
      await expect(page.locator(".conversation-title")).toContainText(
        "记忆恢复",
      );
    }
    await page.keyboard.press("Control+k");
    await page
      .getByRole("combobox", { name: "搜索" })
      .fill(shared ? "设置：共享记忆" : "记忆");
    await page
      .getByRole("option")
      .filter({
        has: page.getByText(shared ? "设置：共享记忆" : "记忆", {
          exact: true,
        }),
      })
      .click();
    if (shared)
      await page
        .getByRole("button", { name: "管理本地记忆", exact: true })
        .click();
    const topic = page.getByLabel(shared ? "共享记忆主题" : "记忆主题", {
      exact: true,
    });
    await expect(topic).toBeDisabled();
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      original,
    );
    const recover = page.getByRole("button", {
      name: "备份原记录并重新编辑",
      exact: true,
    });
    await expect(recover).toBeInViewport();
    await page.screenshot({ path: info.outputPath("blocked-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 760, height: 550 });
    await expect(recover).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("blocked-dark.png") });
    await recover.click();
    await expect(topic).toBeEnabled();
    await topic.fill("新草稿");
    expect(
      await page.evaluate(
        (key) =>
          Object.keys(localStorage)
            .filter((name) => name.startsWith(`${key}:unreadable:`))
            .map((name) => localStorage.getItem(name)),
        key,
      ),
    ).toEqual([original]);
    await page.screenshot({ path: info.outputPath("recovered-dark.png") });
    if (!shared) {
      const deletion = store.execute({
        id: randomUUID(),
        command: {
          type: "entity.delete",
          kind: "bot",
          targetId: bot.id,
          expectedName: "记忆恢复",
        },
      }).id;
      if (!deletion) throw Error("Missing deletion");
      await renderer.emit("workerSignal", {
        state: "live",
        cursor: store.cursor(),
      });
      await expect(
        page.getByRole("dialog", { name: "记忆恢复 的记忆", exact: true }),
      ).toHaveCount(0);
      store.deletionOperations.deletionStart(deletion);
      store.deletionOperations.deletionPlan(deletion);
      store.deletionOperations.deletionComplete(deletion);
      await renderer.emit("workerSignal", {
        state: "live",
        cursor: store.cursor(),
      });
      await expect
        .poll(() =>
          page.evaluate(
            (key) =>
              Object.keys(localStorage).filter((name) => name.startsWith(key)),
            key,
          ),
        )
        .toEqual([]);
    }
    expect(renderer.unhandled).toEqual([]);
  });
}
