import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

/** A real Node distribution is shipped alongside Electron, without its parent lifecycle. */
export async function stageDaemonRuntime(context) {
  const binary = process.env.ASTER_NODE_RUNTIME || process.execPath;
  const { stdout } = await promisify(execFile)(
    binary,
    [
      "--input-type=module",
      "-e",
      'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync(":memory:"); db.close(); console.log(JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node}))',
    ],
    { windowsHide: true },
  );
  const runtime = JSON.parse(stdout.trim());
  const arch = ["ia32", "x64", "armv7l", "arm64", "universal"][context.arch];
  const [major, minor, patch] = runtime.version.split(".").map(Number);
  if (
    runtime.platform !== context.electronPlatformName ||
    runtime.arch !== arch ||
    major < 22 ||
    (major === 22 && (minor < 23 || (minor === 23 && patch < 1)))
  )
    throw new Error(
      "daemon Node 运行时与安装包目标或最低版本不匹配；设置 ASTER_NODE_RUNTIME。禁止回退用户 PATH。",
    );
  const destination = join(
    context.packager.projectDir,
    "build",
    "daemon-runtime",
  );
  await mkdir(destination, { recursive: true });
  await copyFile(
    binary,
    join(destination, runtime.platform === "win32" ? "node.exe" : "node"),
  );
  const license = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${runtime.version}/LICENSE`,
    { signal: AbortSignal.timeout(20000), redirect: "error" },
  );
  if (!license.ok)
    throw new Error("无法取得所打包 Node 版本的 LICENSE，未完成运行时打包。");
  await writeFile(join(destination, "LICENSE.node.txt"), await license.text());
  if (runtime.platform === "win32")
    await writeFile(
      join(destination, "aster-cli.cmd"),
      '@echo off\r\n"%~dp0node.exe" "%~dp0..\\app.asar.unpacked\\node_modules\\@aster\\cli\\dist\\cli\\main.js" %*\r\n',
    );
  else {
    const wrapper = join(destination, "aster-cli");
    await writeFile(
      wrapper,
      '#!/bin/sh\nscript_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$script_dir/node" "$script_dir/../app.asar.unpacked/node_modules/@aster/cli/dist/cli/main.js" "$@"\n',
    );
    await chmod(wrapper, 0o755);
  }
}
