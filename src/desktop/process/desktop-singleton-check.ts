import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Check Chromium's native singleton when the OS cannot identify the desktop PID. */
export async function assertDesktopStopped(
  directory: string,
  executable: string,
) {
  const temporary = await mkdtemp(join(tmpdir(), "aster-desktop-check-"));
  try {
    const script = join(temporary, "check.cjs");
    await writeFile(
      script,
      `const { app } = require('electron');
app.setName('Aster');
app.setPath('userData', ${JSON.stringify(join(directory, "desktop"))});
app.exit(app.requestSingleInstanceLock() ? 0 : 2);
`,
    );
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete env[key];
    try {
      await run(executable, [script], {
        env,
        windowsHide: true,
        timeout: 10000,
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 2)
        throw new Error(
          "旧桌面仍在运行。请从托盘退出原桌面，再执行 pnpm dev；尚未构建或停止后台。",
        );
      throw new Error(
        "无法确认旧桌面已退出，未继续更新。请先退出原桌面，并用 pnpm dev --doctor 检查 Electron 环境。",
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
