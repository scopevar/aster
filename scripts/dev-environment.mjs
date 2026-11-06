import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { inspectLinuxLibraries } from "./dev-libraries.mjs";
import { runNode } from "./dev-process.mjs";

async function electronExecutable(directory) {
  try {
    const relative = (
      await readFile(join(directory, "path.txt"), "utf8")
    ).trim();
    const binary = join(
      process.env.ELECTRON_OVERRIDE_DIST_PATH || join(directory, "dist"),
      relative,
    );
    await access(
      binary,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return binary;
  } catch {
    return undefined;
  }
}

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
  let electronDirectory;
  try {
    for (const dependency of ["esbuild", "sharp", "electron", "electron-vite"])
      require.resolve(dependency);
    electronDirectory = dirname(require.resolve("electron"));
    report("项目依赖", true, "已安装", "");
  } catch {
    report("项目依赖", false, "缺少依赖", "执行 pnpm install，然后 pnpm dev。");
  }
  if (electronDirectory) {
    let binary = await electronExecutable(electronDirectory);
    if (!binary && installElectron && failures.length === 0) {
      console.info(
        "Aster：缺少 Electron 程序，正在自动下载安装，首次下载可能需要几分钟。",
      );
      const code = await runNode(
        root,
        [join(electronDirectory, "install.js")],
        signal,
      );
      if (code === 0) binary = await electronExecutable(electronDirectory);
      else console.error(`Electron 自动安装失败，退出码：${code}。`);
    }
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
