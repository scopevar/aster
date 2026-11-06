import { test, expect } from "../helpers/renderer-app.js";
import { AppError } from "../../src/shared/core.js";
import type { LocalWorkspaceStatus } from "../../src/shared/local-workspace.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspace: LocalWorkspaceStatus = {
  ready: false,
  directory: "D:\\Aster 数据\\local",
  backup: null,
  sources: [
    {
      id: `${accountId}/host-v1`,
      label: `账户 ${accountId} · host-v1`,
      directory: `D:\\工作资料\\Aster 数据\\accounts\\${accountId}\\host-v1`,
    },
    {
      id: "guest/",
      label: "访客",
      directory:
        "D:\\工作资料\\一个用于检查长路径换行的本地目录\\更早的 Aster 桌面数据\\迁移前保留的完整历史\\accounts\\guest",
    },
  ],
};

// Owner: the real gate and bridge boundary. Choosing a directory must be readable,
// remain a local selection until confirmation, and never misreport an interface failure as detected data.
test("legacy directory cards fit compact windows and migrate only the confirmed keyboard selection", async ({
  renderer,
}, info) => {
  const selections: (string | null)[] = [];
  let finish: (() => void) | undefined;
  const page = await renderer.open({
    size: { width: 760, height: 550 },
    colorScheme: "light",
    handlers: {
      localWorkspace: async (request) => {
        if (request.action === "status") return workspace;
        selections.push(request.source);
        return new Promise<LocalWorkspaceStatus>((resolve) => {
          finish = () => resolve({ ...workspace, ready: true, sources: [] });
        });
      },
    },
  });
  const view = page.getByRole("main", { name: "选择本地工作区" });
  await expect(view).toBeVisible();
  await page.screenshot({ path: info.outputPath("workspace-initial.png") });
  const group = view.getByRole("radiogroup", { name: "旧数据目录" });
  const proceed = view.getByRole("button", { name: "迁移并进入", exact: true });
  await expect(group.getByRole("radio")).toHaveCount(2);
  await expect(proceed).toBeDisabled();
  await group.getByText(workspace.sources[0]!.label, { exact: true }).click();
  await expect(group.getByRole("radio").first()).toBeChecked();
  await group.getByRole("radio").first().press("ArrowDown");
  await expect(
    group.getByRole("radio", { name: "访客", exact: true }),
  ).toBeChecked();
  expect(selections).toEqual([]);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const size of [
      { width: 760, height: 550 },
      { width: 1050, height: 760 },
    ]) {
      await page.setViewportSize(size);
      await expect(
        view.getByRole("heading", { name: "选择旧数据", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await expect(proceed).toBeInViewport({ ratio: 1 });
      await expect(
        view.getByText(workspace.sources[1]!.directory, { exact: true }),
      ).toBeInViewport({ ratio: 1 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        await view.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`workspace-${colorScheme}-${size.width}.png`),
      });
    }
  }
  await proceed.click();
  await expect.poll(() => selections).toEqual(["guest/"]);
  await expect(
    view.getByRole("button", { name: "正在迁移…", exact: true }),
  ).toBeDisabled();
  await expect(view.getByRole("radio").first()).toBeDisabled();
  await expect(
    view.getByRole("button", { name: "创建空白工作区", exact: true }),
  ).toBeDisabled();
  if (!finish) throw Error("Missing workspace response");
  finish();
  await expect(page.locator(".main-page")).toBeVisible();
  expect(renderer.unhandled).toEqual([]);
});

test("an old backend failure shows a connection error and retry recovers the actual directory list", async ({
  renderer,
}, info) => {
  let failed = true;
  const page = await renderer.open({
    size: { width: 760, height: 550 },
    handlers: {
      localWorkspace: () => {
        if (failed) throw new AppError("not_found", "未知的后台接口。");
        return workspace;
      },
    },
  });
  const view = page.getByRole("main", { name: "选择本地工作区" });
  await expect(
    view.getByRole("heading", { name: "无法打开本地工作区", exact: true }),
  ).toBeVisible();
  await expect(view.getByRole("alert")).toContainText("停止 daemon 并关闭");
  await expect(view.getByText(/检测到多份数据/)).toHaveCount(0);
  await expect(view.getByRole("radiogroup")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("workspace-backend-error.png"),
  });
  failed = false;
  await view.getByRole("button", { name: "重试连接", exact: true }).click();
  await expect(view.getByRole("radio")).toHaveCount(2);
  await expect(view.getByRole("alert")).toHaveCount(0);
  expect(renderer.unhandled).toEqual([]);
});

test("a workspace without legacy candidates retries opening without a false migration choice", async ({
  renderer,
}) => {
  const selections: (string | null)[] = [];
  const page = await renderer.open({
    handlers: {
      localWorkspace: (request) => {
        if (request.action === "status") return { ...workspace, sources: [] };
        selections.push(request.source);
        return { ...workspace, ready: true, sources: [] };
      },
    },
  });
  const view = page.getByRole("main", { name: "选择本地工作区" });
  await expect(
    view.getByRole("heading", { name: "打开本地工作区", exact: true }),
  ).toBeVisible();
  await expect(view.getByRole("radiogroup")).toHaveCount(0);
  await expect(
    view.getByRole("button", { name: "创建空白工作区", exact: true }),
  ).toHaveCount(0);
  await view
    .getByRole("button", { name: "重试打开本地工作区", exact: true })
    .click();
  await expect(page.locator(".main-page")).toBeVisible();
  expect(selections).toEqual([null]);
  expect(renderer.unhandled).toEqual([]);
});
