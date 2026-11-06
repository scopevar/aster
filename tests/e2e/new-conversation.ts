import type { Page } from "@playwright/test";

async function openAddMenu(page: Page) {
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^(添加|新建会话)$/ })
    .click();
}

export async function newBot(page: Page) {
  if (!(await page.locator(".sidebar").isVisible())) {
    await page
      .getByRole("region", { name: "开始使用 Aster" })
      .getByRole("button", { name: /^(创建助手|先创建助手)$/ })
      .click();
    return;
  }
  await openAddMenu(page);
  await page.getByRole("menuitem", { name: "新建 Bot", exact: true }).click();
}

export async function newGroup(page: Page) {
  await openAddMenu(page);
  await page.getByRole("menuitem", { name: "创建群聊", exact: true }).click();
}

export async function newHuman(page: Page) {
  await openAddMenu(page);
  await page
    .getByRole("menuitem", { name: "发起真人聊天", exact: true })
    .click();
}

export async function openStartConversation(page: Page) {
  await openAddMenu(page);
  await page.getByRole("menuitem", { name: "新建会话", exact: true }).click();
}
