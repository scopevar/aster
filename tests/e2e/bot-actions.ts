import { type Page } from "@playwright/test";

export async function openBotAction(
  page: Page,
  action: "复制 Bot" | "记忆" | "本地模板",
) {
  await page
    .getByRole("button", { name: "搜索会话和操作", exact: true })
    .click();
  const search = page.getByRole("combobox", { name: "搜索", exact: true });
  await search.fill(action);
  await search.press("Enter");
}
