import { nativeImage } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function applicationIcon() {
  const icon = nativeImage.createFromPath(
    join(__dirname, "assets", "aster-app.png"),
  );
  if (icon.isEmpty()) throw new Error("Aster 应用图标资源缺失。");
  return icon;
}

export function trayIcon() {
  const icon = nativeImage.createFromPath(
    join(__dirname, "assets", "aster-tray.png"),
  );
  if (icon.isEmpty()) throw new Error("Aster 托盘图标资源缺失。");
  icon.addRepresentation({
    scaleFactor: 2,
    buffer: readFileSync(join(__dirname, "assets", "aster-tray@2x.png")),
  });
  return icon;
}
