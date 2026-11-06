import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspectDevEnvironment } from "./dev-environment.mjs";
import { runNode } from "./dev-process.mjs";
import { loadProjectEnv } from "./project-env.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const cancellation = new AbortController();
const interrupt = () =>
  cancellation.abort(new DOMException("启动或桌面运行已取消。", "AbortError"));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const run = (script, ...args) =>
  runNode(root, [join(root, script), ...args], cancellation.signal);
try {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--doctor"))
    throw new Error(
      "启动控制端用 pnpm dev（复用已有 daemon）；只读检查用 pnpm dev --doctor。",
    );
  loadProjectEnv(root);
  const environmentReady = await inspectDevEnvironment(root, {
    installElectron: args[0] !== "--doctor",
    signal: cancellation.signal,
  });
  cancellation.signal.throwIfAborted();
  // Doctor still checks the live backend when the graphical environment is unavailable.
  const maintainRuntime = async (action) => {
    const runtime = await import("./dev-runtime.mjs");
    return runtime.maintainRuntime(root, action, cancellation.signal);
  };
  if (args[0] === "--doctor") {
    const status = await maintainRuntime("doctor");
    if (environmentReady && status === 0)
      console.info("环境和后台状态检查通过。启动请执行 pnpm dev。");
    else console.error("检查发现启动阻塞，请按上方对应处理方式修正。");
    process.exitCode = environmentReady ? status : 1;
  } else if (!environmentReady) {
    console.error("启动条件未满足，请按上述处理方式修正后，再执行 pnpm dev。");
    process.exitCode = 1;
  } else if ((await maintainRuntime("doctor")) !== 0) {
    process.exitCode = 2;
  } else {
    console.info("Aster：正在准备源码。");
    const built = await run("scripts/build.mjs");
    if (built !== 0) {
      console.error(
        "构建失败，未启动旧程序。请查看上方具体错误；依赖缺失时执行 pnpm install，修正后执行 pnpm dev。",
      );
      process.exitCode = built;
    } else {
      const electronVite = "node_modules/electron-vite/bin/electron-vite.js";
      process.exitCode = await run(
        existsSync(join(root, electronVite))
          ? electronVite
          : "dist/desktop/launcher.js",
        ...(existsSync(join(root, electronVite)) ? ["dev", "--watch"] : []),
      );
      if (![0, 2, 130, 143].includes(process.exitCode))
        console.error(
          "桌面启动或运行失败。请查看上方错误，并用 pnpm dev --doctor 检查环境。修正后执行 pnpm dev。",
        );
    }
  }
} catch (error) {
  if (cancellation.signal.aborted) {
    console.info("已取消启动或退出桌面。");
    process.exitCode = 130;
  } else {
    console.error(
      error instanceof Error ? error.message : "启动失败，错误原因未知。",
    );
    process.exitCode = 1;
  }
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
