import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { AppError } from "../shared/core.js";
import {
  downloadScriptAsset,
  readVerifiedAsset as verified,
} from "./asset-download.js";
import {
  microsandboxVersion,
  nodeAssets,
  nodeVersion,
  runtimeAssets,
} from "./assets-manifest.js";
import { pythonPackages } from "./python-assets.js";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function sandboxPlatform() {
  const platform = `${process.platform}-${process.arch}`;
  if (
    !(platform in runtimeAssets) ||
    (process.arch !== "x64" && process.arch !== "arm64")
  )
    throw new AppError(
      "unavailable",
      `Microsandbox 不支持 ${platform}；不使用模拟或宿主执行。macOS 需要 Apple Silicon，Linux 需要 glibc 与 KVM，Windows 需要 WHP。`,
    );
  // The membership check above narrows the finite release matrix at this boundary.
  return {
    runtime: runtimeAssets[platform as keyof typeof runtimeAssets],
    arch: process.arch,
  };
}
async function publish(path: string, bytes: Uint8Array) {
  const temporary = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o700 });
    try {
      await link(temporary, path);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
      // Never replace an existing Node binary without verifying its immutable content.
      await verified(path, hash(bytes));
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    });
  }
}
function nodeBinary(archive: Buffer, arch: string) {
  const tar = gunzipSync(archive, { maxOutputLength: 256 * 1024 * 1024 });
  const target = `node-v${nodeVersion}-linux-${arch}/bin/node`;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString()
      .split("\0")[0];
    const size = Number.parseInt(
      tar
        .subarray(offset + 124, offset + 136)
        .toString()
        .replaceAll("\0", "")
        .trim(),
      8,
    );
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > tar.length
    )
      break;
    if (name === target && tar[offset + 156] === 48)
      return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new AppError(
    "unavailable",
    "固定 Node 归档中没有预期的 Linux 二进制，未启动沙箱。",
  );
}
async function scriptRuntime(directory: string) {
  const { runtime, arch } = sandboxPlatform();
  const sdkRequire = createRequire(
    createRequire(import.meta.url).resolve("microsandbox/native"),
  );
  const packageRoot = dirname(
    sdkRequire.resolve(
      `@superradcompany/microsandbox-${runtime.package}/package.json`,
    ),
  );
  z.object({ version: z.literal(microsandboxVersion) }).parse(
    JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  );
  const msbPath = join(packageRoot, "bin", runtime.executable);
  const libkrunfwPath = join(packageRoot, "lib", runtime.library);
  if (
    !(await verified(msbPath, runtime.msb)) ||
    !(await verified(libkrunfwPath, runtime.firmware))
  )
    throw new AppError(
      "unavailable",
      "缺少 Microsandbox 原生运行时；请安装本平台的可选依赖。",
    );
  return { node: join(directory, `node-${arch}`), msbPath, libkrunfwPath };
}

export async function loadScriptAssets(directory: string) {
  const assets = await scriptRuntime(directory);
  const { arch } = sandboxPlatform();
  if (!(await verified(assets.node, nodeAssets[arch].binary)))
    throw new AppError("unavailable", "脚本环境资源尚未准备完成，脚本未执行。");
  for (const asset of pythonPackages(arch)) {
    if (!(await verified(join(directory, asset.file), asset.sha256)))
      throw new AppError(
        "unavailable",
        "脚本环境资源尚未准备完成，脚本未执行。",
      );
  }
  return assets;
}

/** Runs only in the owned preparation process, independently of any chat task. */
export async function prepareScriptAssets(
  directory: string,
  signal: AbortSignal,
  status: (detail: string) => void,
) {
  const assets = await scriptRuntime(directory);
  const { arch } = sandboxPlatform();
  await mkdir(directory, { recursive: true });
  const download = (file: string, url: string, sha256: string, limit: number) =>
    downloadScriptAsset(
      { path: join(directory, file), url, sha256, limit },
      signal,
      (bytes, total) =>
        status(
          `正在准备 ${file}：${(bytes / 1048576).toFixed(1)} MiB${total ? ` / ${(total / 1048576).toFixed(1)} MiB` : ""}；支持断点续传，脚本尚未执行。`,
        ),
    );
  const node = join(directory, `node-${arch}`);
  if (!(await verified(node, nodeAssets[arch].binary))) {
    status("首次准备：正在下载并校验 Linux Node 22.23.1；脚本尚未执行。");
    const archive = await download(
      `node-${arch}.tar.gz`,
      `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-${arch}.tar.gz`,
      nodeAssets[arch].archive,
      64 * 1024 * 1024,
    );
    const binary = nodeBinary(archive, arch);
    if (hash(binary) !== nodeAssets[arch].binary)
      throw new AppError("unavailable", "Linux Node 二进制校验失败。");
    await publish(node, binary);
  }
  for (const asset of pythonPackages(arch)) {
    const path = join(directory, asset.file);
    if (await verified(path, asset.sha256)) continue;
    status(`首次准备：正在下载并校验 ${asset.file}；脚本尚未执行。`);
    await download(asset.file, asset.url, asset.sha256, 128 * 1024 * 1024);
  }
  return assets;
}
