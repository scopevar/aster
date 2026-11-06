import { fileURLToPath } from "node:url";

const usage = `发布请前往 GitHub Actions → Build and release → Run workflow，选择 main 分支。
channel 可选 preview、nightly 或 stable，操作说明见 docs/releasing.md。
本地 pnpm release 只显示指引，不构建、上传或修改版本。
CI 入口：pnpm release --ci plan [preview|nightly|stable]，或 --ci build / publish / sync-version。`;

try {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    console.info(usage);
  } else if (args[0] === "--ci") {
    const { runCiRelease } = await import("./release-ci.js");
    await runCiRelease(
      fileURLToPath(new URL("..", import.meta.url)),
      args.slice(1),
    );
  } else {
    throw new Error(`不支持本地发布参数。\n${usage}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "发布失败。");
  process.exitCode = 1;
}
