import { join, resolve } from "node:path";
import { inspectWorker, stopWorker } from "./worker-maintenance.js";
import { electronExecutable } from "../process/electron-executable.js";
import { inspectDesktop, stopDesktop } from "../process/desktop-instance.js";
import { assertDesktopStopped } from "../process/desktop-singleton-check.js";
import { inspectDaemonCredentials } from "../../daemon/doctor.js";

const action = process.argv[2],
  root = resolve(process.argv[3] ?? ".");
const directory = resolve(
  process.env.ASTER_DATA_DIR ?? join(root, ".runtime/aster"),
);
try {
  process.env.ASTER_STRICT_SECRETS = "1";
  if (!["doctor", "restart"].includes(action ?? ""))
    throw new Error("未知维护操作。");
  let executable: string | undefined;
  try {
    executable = await electronExecutable(root);
  } catch {
    console.error(
      "✗ Electron 程序：未安装或不可执行；未自动下载。请执行 pnpm exec install-electron --no，再执行 pnpm dev --doctor。",
    );
    if (action === "restart") throw new Error("修复 Electron 安装后再重启。");
    process.exitCode = 2;
  }
  if (action === "restart" && executable) {
    const desktop = await inspectDesktop(directory, executable);
    if (desktop.state === "unverified") throw new Error(desktop.message);
    if (desktop.state === "unsupported")
      await assertDesktopStopped(directory, executable);
    await stopDesktop(directory, executable);
    await stopWorker(directory);
    console.info("旧桌面和后台已退出，可以构建并启动当前版本。");
  } else {
    const worker = await inspectWorker(directory);
    if (worker.state === "unverified") {
      console.error(`✗ 后台状态：${worker.message}`);
      console.error(
        "请检查连接记录及目录持有者后重试；pnpm dev 不会自动停止或接管已有后台。",
      );
      process.exitCode = 2;
    } else if (worker.state === "running") {
      if (worker.endpoint.kind !== "daemon")
        throw new Error(
          "此目录由旧 Worker 占用，请从原入口明确停止；未自动接管。",
        );
      console.info(
        "✓ daemon 状态：正在运行；启动控制端将连接现有实例，不会停止或重复启动。",
      );
      console.info(
        "凭据检查：运行中未重读磁盘凭据；本次仅确认已鉴权的健康响应。",
      );
    } else if (executable) {
      process.env.ASTER_ELECTRON_BIN = executable;
      process.env.ASTER_ELECTRON_APP = join(
        root,
        "src/platform/safe-storage-host.cjs",
      );
      const checked = await inspectDaemonCredentials(directory);
      console.info(
        checked
          ? `✓ 已有凭据：${checked} 个文件可解密；检查未改写原文件。`
          : "已有凭据：未发现模型凭据；未验证首次保存时的密钥环可用性。",
      );
      console.info(
        "daemon 状态：当前未运行；启动 Desktop 时将尝试启动，尚未确认启动成功。",
      );
    }
    const desktop = executable
      ? await inspectDesktop(directory, executable)
      : undefined;
    if (desktop?.state === "running") {
      console.info(`桌面实例：本项目已有进程 ${desktop.pid}。`);
    } else if (desktop?.state === "unverified") {
      console.error(`✗ 桌面状态：${desktop.message}`);
      process.exitCode = 2;
    }
  }
} catch (error) {
  console.error(
    `后台维护失败：${error instanceof Error ? error.message : "未知错误"}`,
  );
  process.exitCode = 2;
}
