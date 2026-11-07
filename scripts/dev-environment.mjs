import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { inspectLinuxLibraries } from "./dev-libraries.mjs";
import { prepareElectron } from "./prepare-electron.mjs";

/**
 * Report only failed startup requirements; a healthy environment prints nothing.
 * Never dump the environment.
 */
export async function inspectDevEnvironment(
  root,
  { installElectron = false, signal } = {},
) {
  const failures = [];
  const report = (name, ready, detail, action) => {
    if (ready) return;
    console.info(`✗ ${name}：${detail}`);
    console.error(`  处理方式：${action}`);
    failures.push(name);
  };
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  report(
    "Node.js",
    major > 22 ||
      (major === 22 && (minor > 23 || (minor === 23 && patch >= 1))),
    process.version,
    "使用 nvm 时执行 nvm install 和 nvm use（读取 .nvmrc）；其他方式请安装 Node.js ≥22.23.1，再执行 pnpm install 和 pnpm dev。",
  );
  const supported = ["win32", "linux"].includes(process.platform);
  report(
    "操作系统",
    supported,
    process.platform,
    "请在 Windows 或 Ubuntu/Linux 上执行 pnpm dev。",
  );
  if (process.platform === "linux") {
    const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
    report(
      "图形会话",
      Boolean(display),
      display ? "已配置" : "未发现 DISPLAY 或 WAYLAND_DISPLAY",
      "请打开 Ubuntu 图形桌面中的终端，再执行 pnpm dev。纯 SSH 会话需要先配置图形转发。",
    );
    report(
      "运行用户",
      process.getuid?.() !== 0,
      process.getuid?.() === 0 ? "root" : "普通用户",
      "请使用桌面的普通用户执行 pnpm dev，不要使用 sudo。",
    );
  }
  const require = createRequire(join(root, "package.json"));
  let dependenciesReady = false;
  try {
    for (const dependency of ["esbuild", "sharp", "electron", "electron-vite"])
      require.resolve(dependency);
    dependenciesReady = true;
    report("项目依赖", true, "已安装", "");
  } catch {
    report("项目依赖", false, "缺少依赖", "执行 pnpm install，然后 pnpm dev。");
  }
  if (dependenciesReady) {
    const binary = await prepareElectron(root, {
      install: installElectron && failures.length === 0,
      signal,
    });
    if (binary) {
      report("Electron 程序", true, "存在且可执行", "");
    } else {
      report(
        "Electron 程序",
        false,
        "未安装或不可执行",
        "执行 pnpm exec install-electron --no，然后 pnpm dev。若下载失败，请查看上方网络错误。",
      );
    }
    if (binary && process.platform === "linux") {
      const libraries = await inspectLinuxLibraries(binary);
      if (libraries.state === "unchecked") {
        console.info(`⚠ Electron 系统库：${libraries.detail}`);
        console.info(`  ${libraries.action}`);
      } else {
        report(
          "Electron 系统库",
          libraries.state === "ready",
          libraries.detail,
          libraries.action,
        );
      }
    }
  }
  for (const [name, file] of [["应用图标原图", "aster-icon.png"]]) {
    try {
      await access(join(root, "assets", file));
      report(name, true, `assets/${file} 存在`, "");
    } catch {
      report(
        name,
        false,
        `缺少 assets/${file}`,
        `执行 git restore -- assets/${file}，然后 pnpm dev。`,
      );
    }
  }
  if (process.env.ELECTRON_RUN_AS_NODE)
    console.info(
      "提示：检测到 ELECTRON_RUN_AS_NODE；启动桌面时会自动清除，无需手动修改。",
    );
  return failures.length === 0;
}
