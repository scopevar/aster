import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "../helpers/desktop-test.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localWorkspaceDirectory } from "../../src/platform/app-data-directory.js";
import { readWorker } from "../../src/worker/client.js";
import { envelopeSchema } from "../../src/shared/commands.js";
import { Store } from "../../src/storage/store.js";
import { workerSnapshot } from "../helpers/worker-snapshot.js";
import type { BackupRequest } from "../../src/shared/backup.js";
import { openDesktop } from "../helpers/local-desktop.js";

async function backup(page: Page, action: BackupRequest["action"]) {
  const result = await page.evaluate(
    (action) => window.aster.backup({ action }),
    action,
  );
  if (!result.success) throw Error(result.error.message);
  return result.data;
}

test("backup IPC restores on the next worker start and can return to the replaced database", async ({
  desktop,
}, info) => {
  const directory = desktop.directory;
  const outside = await mkdtemp(join(tmpdir(), "aster-backup-ui-out-"));
  const accountDirectory = localWorkspaceDirectory(directory);
  await mkdir(accountDirectory, { recursive: true });
  // Local fixtures have no cloud operations that would replay after a restore.
  const create = (name: string) => {
    const store = new Store(join(accountDirectory, "aster.sqlite"));
    try {
      store.execute(
        envelopeSchema.parse({
          id: randomUUID(),
          command: { type: "bot.create", name, description: "" },
        }),
      );
    } finally {
      store.close();
    }
  };
  create("备份前");
  let app: ElectronApplication = await desktop.launch({});
  try {
    let page = await openDesktop(app);
    await page.getByRole("button", { name: /^应用菜单/ }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "数据与备份", exact: true }).click();
    const settings = page.getByRole("region", { name: "本地数据与备份" });
    await expect(
      settings.getByRole("button", { name: "导出本地备份", exact: true }),
    ).toBeEnabled();
    const names = async () =>
      (await workerSnapshot(await readWorker(directory))).bots.map(
        (bot) => bot.name,
      );
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
    });
    await settings
      .getByRole("button", { name: "导出本地备份", exact: true })
      .click();
    const notice = page
      .getByRole("region", { name: "通知", exact: true })
      .getByRole("alertdialog", { name: "未保存备份。", exact: true });
    await expect(notice).toBeVisible();
    await notice.hover();
    await page.screenshot({
      path: info.outputPath("local-backup-settings.png"),
    });
    await notice.getByRole("button", { name: "关闭提示", exact: true }).click();
    const snapshot = join(outside, "chat.sqlite");
    await app.evaluate(
      ({ dialog }, path) => {
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: path,
        });
      },
      join(localWorkspaceDirectory(directory), "inside.sqlite"),
    );
    await expect(backup(page, "save")).rejects.toThrow(
      "备份不能写进当前数据目录。",
    );
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, snapshot);
    expect((await backup(page, "save")).notice).toContain(
      "已保存：chat.sqlite",
    );
    await desktop.stop();
    create("备份后");
    app = await desktop.launch({});
    page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: /^应用菜单/, exact: true }),
    ).toBeVisible({ timeout: 35000 });
    expect(await names()).toContain("备份后");
    const junk = join(outside, "notes.txt");
    await writeFile(junk, "not a database");
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, junk);
    await expect(backup(page, "schedule")).rejects.toThrow(
      "无法读取这份备份。",
    );
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, snapshot);
    expect((await backup(page, "schedule")).notice).toContain(
      "已安排下次启动后台时恢复",
    );
    await desktop.stop();
    app = await desktop.launch({});
    page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: /^应用菜单/, exact: true }),
    ).toBeVisible({ timeout: 35000 });
    const restored = await backup(page, "status");
    expect(restored.notice).toContain("已用备份替换");
    expect(restored.previousAvailable).toBe(true);
    expect(await names()).toContain("备份前");
    expect(await names()).not.toContain("备份后");
    expect((await backup(page, "schedule-previous")).notice).toContain(
      "已安排下次启动后台时恢复",
    );
    await desktop.stop();
    app = await desktop.launch({});
    page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: /^应用菜单/, exact: true }),
    ).toBeVisible({ timeout: 35000 });
    expect(await names()).toEqual(expect.arrayContaining(["备份前", "备份后"]));
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
