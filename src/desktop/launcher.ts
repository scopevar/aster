import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AppError } from "../shared/core.js";
import { runDesktop } from "./process/desktop-process.js";

// Development launcher only; Main connects to the independent local daemon.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = resolve(
  process.env.ASTER_DATA_DIR ?? join(root, ".runtime/aster"),
);
try {
  const require = createRequire(import.meta.url);
  const executable = z.string().parse(require("electron"));
  console.info("Aster：正在启动桌面和后台。");
  process.exitCode = await runDesktop(executable, root, directory);
} catch (error) {
  console.error(
    `Aster 启动失败：${error instanceof Error ? error.message : "未知错误"}`,
  );
  if (error instanceof AppError && error.code === "conflict")
    console.error(
      "请检查此数据目录的后台归属；更新后台代码前须从原入口明确停止，再执行 pnpm dev。",
    );
  else
    console.error(
      "请执行 pnpm dev --doctor 检查环境；若后台启动失败，请按上方错误修正后再执行 pnpm dev。",
    );
  process.exitCode =
    error instanceof AppError && error.code === "conflict" ? 2 : 1;
}
