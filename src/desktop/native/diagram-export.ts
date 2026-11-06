import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/core.js";
import { validateDiagramSvg } from "../../shared/files/diagram-export.js";
import {
  installedApplicationDirectory,
  isApplicationPath,
} from "../../platform/application-paths.js";

async function statOrMissing(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
async function remove(path: string) {
  await unlink(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  });
}

/** Replaces a regular .svg atomically. Refuses links, directories, and the installed app directory. */
export async function saveDiagramFile(
  file: string,
  svg: string,
  applicationDirectory = installedApplicationDirectory(),
): Promise<string> {
  const text = validateDiagramSvg(svg);
  if (file.includes("\0") || file.length > 4096)
    throw new AppError("invalid_input", "路径无效。");
  if (extname(file).toLowerCase() !== ".svg")
    throw new AppError("invalid_input", "图表只能保存为 .svg 文件。");
  if (isApplicationPath(file, applicationDirectory))
    throw new AppError("unauthorized", "不能把图表写进已安装程序目录。");
  const selected = resolve(file);
  const parent = dirname(selected);
  const parentInfo = await statOrMissing(parent);
  if (!parentInfo) throw new AppError("invalid_input", "目标目录不存在。");
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory())
    throw new AppError("invalid_input", "目标目录无效。");
  const realParent = await realpath(parent);
  if (isApplicationPath(realParent, applicationDirectory))
    throw new AppError("unauthorized", "不能把图表写进已安装程序目录。");
  const target = join(realParent, basename(selected));
  if (extname(target).toLowerCase() !== ".svg")
    throw new AppError("invalid_input", "图表只能保存为 .svg 文件。");
  const existing = await statOrMissing(target);
  if (existing && (existing.isSymbolicLink() || !existing.isFile()))
    throw new AppError(
      "invalid_input",
      "图表必须保存为普通 SVG 文件，不能是链接或目录。",
    );
  const temporary = join(realParent, `.aster-diagram-${randomUUID()}.partial`);
  const displaced = join(
    realParent,
    `.aster-diagram-${randomUUID()}.displaced`,
  );
  let staged = false;
  let moved = false;
  let committed = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    staged = true;
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (existing) {
      await rename(target, displaced);
      moved = true;
    }
    await rename(temporary, target);
    staged = false;
    committed = true;
    if (moved) {
      await remove(displaced);
      moved = false;
    }
  } finally {
    if (!committed) {
      if (staged) await remove(temporary);
      if (moved) await rename(displaced, target);
    }
  }
  return basename(target);
}
