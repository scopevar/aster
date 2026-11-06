import { mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";

/** Desktop reuses Electron's Node mode; the standalone CLI still uses system Node. */
export async function stageDaemonRuntime(context) {
  const destination = join(
    context.packager.projectDir,
    "build",
    "daemon-runtime",
  );
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  if (context.electronPlatformName === "win32") {
    await writeFile(
      join(destination, "aster-cli.cmd"),
      '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\..\\aster.exe" "%~dp0..\\app.asar.unpacked\\node_modules\\@aster\\cli\\dist\\cli\\main.js" %*\r\n',
    );
  } else {
    const wrapper = join(destination, "aster-cli");
    await writeFile(
      wrapper,
      '#!/bin/sh\nscript_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nELECTRON_RUN_AS_NODE=1 exec "$script_dir/../../aster" "$script_dir/../app.asar.unpacked/node_modules/@aster/cli/dist/cli/main.js" "$@"\n',
    );
    await chmod(wrapper, 0o755);
  }
}
