import { randomUUID } from "node:crypto";
import { chmodSync, renameSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../../shared/core.js";
import { flushFile } from "../backup/backup-files.js";

/** VACUUM INTO includes committed WAL pages and leaves the original database untouched. */
export function saveMigrationBackup(db: DatabaseSync, version: number) {
  const file = db
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main")?.file;
  if (typeof file !== "string" || file === "") return;
  const destination = `${file}.pre-upgrade-v${version}-${randomUUID()}.sqlite`;
  const temporary = `${destination}.partial`;
  try {
    db.prepare("VACUUM main INTO ?").run(temporary);
    chmodSync(temporary, 0o600);
    flushFile(temporary);
    renameSync(temporary, destination);
  } catch {
    rmSync(temporary, { force: true });
    throw new AppError(
      "unavailable",
      "无法保存升级前备份，数据库尚未升级。请检查磁盘空间和目录权限后重试。",
    );
  }
}
