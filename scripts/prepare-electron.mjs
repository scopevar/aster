import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

/** Resolve without evaluating Electron's entry, which can download as a side effect. */
export async function prepareElectron(root, { install = true, signal } = {}) {
  const require = createRequire(join(root, "package.json"));
  const directory = dirname(require.resolve("electron"));
  let binary = await electronExecutable(directory);
  if (!binary && install) {
    console.info(
      "Aster：缺少 Electron 程序，正在自动下载安装，首次下载可能需要几分钟。",
    );
    const code = await runNode(root, [join(directory, "install.js")], signal);
    if (code === 0) binary = await electronExecutable(directory);
    else console.error(`Electron 自动安装失败，退出码：${code}。`);
  }
  return binary;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const cancellation = new AbortController();
  const interrupt = () =>
    cancellation.abort(new Error("Electron 准备已取消。"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (
      !(await prepareElectron(process.cwd(), { signal: cancellation.signal }))
    ) {
      throw new Error(
        "Electron 程序未安装或不可执行，准备失败。请检查上方下载错误，修复后重试。",
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
