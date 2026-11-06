import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (process.platform !== "win32")
  throw new Error("桌面快捷方式创建命令需要 Windows。");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(root, "dist", "desktop", "launcher.js");
const icon = join(root, "dist", "desktop", "assets", "aster.ico");
try {
  await Promise.all([access(launcher), access(icon)]);
} catch {
  throw new Error(
    "缺少桌面资源，请先执行 pnpm dev，再运行 pnpm run desktop:shortcut。",
  );
}
const script = `
$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$path = Join-Path $desktop 'Aster.lnk'
$ws = New-Object -ComObject WScript.Shell
$link = $ws.CreateShortcut($path)
if ((Test-Path $path) -and ($link.TargetPath -ne $env:ASTER_SHORTCUT_NODE -or $link.WorkingDirectory -ne $env:ASTER_SHORTCUT_ROOT)) {
  throw 'Aster.lnk 已被其他程序使用，未覆盖。'
}
$link.TargetPath = $env:ASTER_SHORTCUT_NODE
$link.Arguments = '"' + $env:ASTER_SHORTCUT_LAUNCHER + '"'
$link.WorkingDirectory = $env:ASTER_SHORTCUT_ROOT
$link.IconLocation = $env:ASTER_SHORTCUT_ICON + ',0'
$link.Description = 'Aster 桌面 AI 助手'
$link.Save()
Write-Output $path
`;
const result = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", script],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ASTER_SHORTCUT_NODE: process.execPath,
      ASTER_SHORTCUT_LAUNCHER: launcher,
      ASTER_SHORTCUT_ROOT: root,
      ASTER_SHORTCUT_ICON: icon,
    },
  },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("桌面快捷方式创建失败。");
