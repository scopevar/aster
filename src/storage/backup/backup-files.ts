import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import { isApplicationPath } from "../../platform/application-paths.js";
export function databasePath(file: string) {
  if (file === ":memory:" || file.includes("\0"))
    throw new AppError("invalid_input", "数据库路径无效。");
  return resolve(file);
}
export function flushFile(path: string) {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
const previousName = "aster.sqlite.previous";
export function isInside(parent: string, child: string) {
  const fromParent = relative(resolve(parent), resolve(child));
  return (
    fromParent === "" ||
    (!isAbsolute(fromParent) && !fromParent.startsWith(".."))
  );
}
export function rejectProtectedData(
  dataDirectory: string,
  applicationDirectory?: string,
) {
  if (isApplicationPath(dataDirectory, applicationDirectory))
    throw new AppError("unauthorized", "不能在已安装程序目录里备份或恢复。");
}
export function outsideData(
  dataDirectory: string,
  file: string,
  writing: boolean,
  applicationDirectory?: string,
) {
  if (file.includes("\0")) throw new AppError("invalid_input", "路径无效。");
  const path = resolve(file);
  if (isApplicationPath(path, applicationDirectory))
    throw new AppError("unauthorized", "不能使用已安装程序目录。");
  if (isInside(dataDirectory, path))
    throw new AppError(
      "invalid_input",
      writing
        ? "备份不能写进当前数据目录。"
        : "不能从当前数据目录里的文件恢复。",
    );
  return path;
}
export function regularFile(path: string) {
  if (!existsSync(path)) throw new AppError("not_found", "文件不存在。");
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new AppError(
      "invalid_input",
      "必须是普通数据库文件，不能是链接或目录。",
    );
}
export function realDestination(path: string, applicationDirectory?: string) {
  const parent = dirname(path);
  if (!existsSync(parent))
    throw new AppError("invalid_input", "目标目录不存在。");
  const parentInfo = lstatSync(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory())
    throw new AppError("invalid_input", "目标目录无效。");
  const realParent = realpathSync(parent);
  if (isApplicationPath(realParent, applicationDirectory))
    throw new AppError("unauthorized", "不能使用已安装程序目录。");
  return join(realParent, basename(path));
}
export async function copyReadOnly(
  sourceFile: string,
  destinationFile: string,
) {
  if (existsSync(destinationFile))
    throw new AppError("conflict", "恢复临时文件已存在。");
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const temporary = `${destinationFile}.partial`;
  try {
    source.exec("PRAGMA busy_timeout=5000");
    const pages = await backup(source, temporary);
    if (typeof pages !== "number" || pages < 1)
      throw new AppError("unavailable", "备份没有写出数据库页。");
    renameSync(temporary, destinationFile);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    source.close();
  }
}
export function writeJson(directory: string, name: string, value: unknown) {
  const target = join(directory, name);
  const temporary = join(
    directory,
    `.${name}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function readJson(directory: string, name: string) {
  const path = join(directory, name);
  if (!existsSync(path)) return undefined;
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 65536
  )
    throw new AppError(
      "unavailable",
      "恢复记录不是有效的普通文件，原件已保留。",
    );
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
export function previousPath(dataDirectory: string) {
  return join(resolve(dataDirectory), previousName);
}
export function previousAvailable(dataDirectory: string) {
  const path = previousPath(dataDirectory);
  if (!existsSync(path)) return false;
  const info = lstatSync(path);
  return info.isFile() && !info.isSymbolicLink();
}
export function removeSidecars(file: string) {
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
}
export function checkpoint(file: string) {
  if (!existsSync(file)) return;
  internalFile(file);
  for (const suffix of ["-wal", "-shm"]) internalFile(`${file}${suffix}`);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const result = z
      .object({ busy: z.number() })
      .parse(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get());
    if (result.busy !== 0)
      throw new AppError(
        "conflict",
        "原数据库仍被占用，未删除日志或替换数据库。",
      );
  } finally {
    db.close();
  }
}
export function internalFile(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new AppError(
        "unavailable",
        "恢复现场含链接或非普通文件，已保留现场并停止启动。",
      );
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
