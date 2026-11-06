import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../shared/core.js";
import { prepareScriptAssets } from "./assets.js";
import type { loadScriptAssets } from "./assets.js";
import { scriptImage } from "./assets-manifest.js";
import type { SandboxPreparation } from "./protocol.js";

export async function configureScriptRuntime(
  config: SandboxPreparation,
  assets: Awaited<ReturnType<typeof loadScriptAssets>>,
) {
  await mkdir(config.home, { recursive: true });
  const path = join(config.home, `config-${randomUUID()}.partial`);
  await writeFile(
    path,
    JSON.stringify({
      paths: { msb: assets.msbPath, libkrunfw: assets.libkrunfwPath },
    }),
    { flag: "wx" },
  );
  await rename(path, join(config.home, "config.json"));
  process.env.MSB_HOME = config.home;
}

/** Pull immutable image resources without creating a VM or mounting user data. */
export async function prepareScriptResources(
  config: SandboxPreparation,
  signal: AbortSignal,
  status: (detail: string) => void,
) {
  try {
    const assets = await prepareScriptAssets(config.assets, signal, status);
    signal.throwIfAborted();
    await configureScriptRuntime(config, assets);
    status("正在下载并准备固定 Linux 镜像，支持断点续传；脚本尚未执行。");
    const child = spawn(assets.msbPath, ["pull", scriptImage, "--quiet"], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      signal,
    });
    let diagnostics = "";
    child.stderr.on("data", (bytes: Buffer) => {
      diagnostics = (diagnostics + bytes.toString("utf8")).slice(-600);
    });
    await new Promise<void>((resolve, reject) => {
      let failure: Error | undefined;
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code) => {
        if (signal.aborted) reject(signal.reason);
        else if (failure) reject(failure);
        else if (code !== 0)
          reject(
            new Error(
              `固定 Linux 镜像准备失败（退出码 ${code}）。${diagnostics}`,
            ),
          );
        else resolve();
      });
    });
    status("固定脚本资源已准备并校验完成，虚拟机将在任务执行时启动。");
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new AppError(
      "unavailable",
      `脚本环境资源准备失败，已保留下载进度，可重试。${error instanceof Error ? error.message : ""}`.slice(
        0,
        1000,
      ),
    );
  }
}
