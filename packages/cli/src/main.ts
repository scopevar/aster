#!/usr/bin/env node
import { localWorkspaceRequestSchema } from "../../../src/shared/local-workspace.js";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { migrateDaemonSecrets } from "../../../src/daemon/migrate-secrets.js";
import { fileURLToPath } from "node:url";
import {
  daemonStatus,
  ensureDaemon,
  stopDaemon,
} from "../../../src/daemon/lifecycle.js";
import { resolveAppDataDirectory } from "../../../src/platform/app-data-directory.js";
import { callWorker, readWorker } from "../../../src/worker/client.js";
import { workerRoutes } from "../../../src/shared/protocol.js";
import { envelopeSchema } from "../../../src/shared/commands.js";
import { querySchema } from "../../../src/shared/snapshot.js";
import { agentConnectionsRequestSchema } from "../../../src/shared/agent-connections.js";
import { pluginWorkerRequestSchema } from "../../../src/shared/tools/plugins.js";

async function input(): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("输入超过大小限制。");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf("--data-dir");
  let configured = process.env.ASTER_DATA_DIR;
  if (dirIndex !== -1) {
    configured = args[dirIndex + 1];
    if (!configured) throw new Error("--data-dir 需要目录。");
    args.splice(dirIndex, 2);
  }
  const [action = "help", ...extra] = args;
  const directory = resolveAppDataDirectory({
    configured,
    packaged: true,
    home: homedir(),
    xdgDataHome: process.env.XDG_DATA_HOME,
    cwd: process.cwd(),
  });
  if (extra.length)
    throw new Error("无效参数；秘密及配置仅从 stdin JSON 读取。");
  if (action === "help" || action === "--help") {
    console.log(`aster [--data-dir <目录>] <操作>
run                     前台运行，SIGINT/SIGTERM 正常停止
start     后台启动；已有独立实例则连接，不接管其生命周期
status    验证本机鉴权与 PID，只输出公开状态
stop      明确停止此目录的 daemon，等待有界清理确认
workspace 从 stdin 选择旧数据或查看本地工作区（status/select）
models    从 stdin 读取模型配置（status/save/assign/check/test）
plugins   从 stdin 本机安装/配置插件（prepare/install/configure/list 等）
command   从 stdin 读取带 UUID 的命令信封；支持现有 Bot、会话、任务及目录操作
snapshot  从 stdin 读取查询（例如 {}），查看持久化执行结果
migrate-secrets 显式离线升级此目录的旧 safeStorage 密钥包装，保留密封内容
退出客户端不会停止已接受任务；unknown 操作须人工核实，不能换 UUID 自动重放。`);
    return;
  }
  if (action === "run") {
    const { runDaemon } = await import("../../../src/daemon/run.js");
    await runDaemon(directory);
    return;
  }
  if (action === "migrate-secrets") {
    console.log(JSON.stringify(await migrateDaemonSecrets(directory)));
    return;
  }
  if (action === "start") {
    const endpoint = await ensureDaemon(directory, {
      executable: process.execPath,
      script: resolve(fileURLToPath(import.meta.url)),
    });
    console.log(
      JSON.stringify({ state: "running", pid: endpoint.pid, directory }),
    );
    return;
  }
  if (action === "status") {
    const endpoint = await daemonStatus(directory);
    console.log(
      JSON.stringify({
        state: endpoint ? "running" : "offline",
        pid: endpoint?.pid ?? null,
        kind: endpoint?.kind ?? null,
        role: endpoint?.role ?? null,
        directory,
      }),
    );
    return;
  }
  if (action === "stop") {
    await stopDaemon(directory);
    console.log(JSON.stringify({ state: "stopped", cleaned: true }));
    return;
  }
  const endpoint = await readWorker(directory, undefined, 5000).catch(
    (error: unknown) => {
      if (error instanceof Error && error.name === "TimeoutError")
        throw new Error("后台健康检查超时（5 秒），尚未提交业务请求。");
      throw error;
    },
  );
  let path: string, body: unknown;
  switch (action) {
    case "plugins":
      path = workerRoutes.plugins;
      body = pluginWorkerRequestSchema.parse(await input());
      break;
    case "workspace":
      path = workerRoutes.localWorkspace;
      body = localWorkspaceRequestSchema.parse(await input());
      break;
    case "models":
      path = workerRoutes.agentConnections;
      body = agentConnectionsRequestSchema.parse(await input());
      break;
    case "command":
      path = workerRoutes.command;
      body = envelopeSchema.parse(await input());
      break;
    case "snapshot":
      path = workerRoutes.snapshot;
      body = querySchema.parse(await input());
      break;
    default:
      throw new Error("未知操作，执行 aster help 查看帮助。");
  }
  console.log(JSON.stringify(await callWorker(endpoint, path, body)));
}

void main().catch((error: unknown) => {
  // Validation diagnostics can embed credential input; never print them.
  console.error(
    error instanceof Error && error.name !== "ZodError"
      ? error.message
      : "输入不符合专用操作契约，未执行。",
  );
  process.exitCode = 1;
});
