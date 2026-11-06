import { join, resolve } from "node:path";

export function localWorkspaceDirectory(directory: string) {
  return join(directory, "local");
}

/** 安装版不能跟着启动时的当前目录走，否则任意目录都会找不到 endpoint.json。 */
export function resolveAppDataDirectory(input: {
  configured: string | undefined;
  packaged: boolean;
  home: string;
  xdgDataHome: string | undefined;
  cwd: string;
}): string {
  const configured = input.configured?.trim();
  if (configured) return resolve(input.cwd, configured);
  if (input.packaged) {
    const base = input.xdgDataHome?.trim()
      ? input.xdgDataHome.trim()
      : join(input.home, ".local", "share");
    return resolve(input.cwd, base, "aster");
  }
  return resolve(input.cwd, ".runtime/aster");
}
