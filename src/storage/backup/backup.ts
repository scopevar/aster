import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  maxDatabaseVersion,
  minDatabaseVersion,
  type BackupStatus,
} from "../../shared/backup.js";
import { AppError } from "../../shared/core.js";
import { isApplicationPath } from "../../platform/application-paths.js";
import {
  checkpoint,
  copyReadOnly,
  databasePath,
  flushFile,
  internalFile,
  isInside,
  outsideData,
  previousAvailable,
  previousPath,
  readJson,
  realDestination,
  regularFile,
  rejectProtectedData,
  removeSidecars,
  writeJson,
} from "./backup-files.js";
import { Store } from "../store.js";

/** Copies a committed SQLite snapshot, including attachment blobs, without copying the live file. */
export async function backupDatabase(
  sourceFile: string,
  destinationFile: string,
) {
  const sourcePath = databasePath(sourceFile);
  const destinationPath = databasePath(destinationFile);
  if (sourcePath === destinationPath)
    throw new AppError("invalid_input", "备份不能覆盖正在使用的数据库。");
  if (existsSync(destinationPath))
    throw new AppError("conflict", "备份目标已存在。");
  regularFile(sourcePath);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const temporary = join(
    dirname(destinationPath),
    `.backup-${randomBytes(4).toString("hex")}.sqlite`,
  );
  try {
    source.exec("PRAGMA busy_timeout=5000");
    const pages = await backup(source, temporary);
    if (typeof pages !== "number" || pages < 1)
      throw new AppError("unavailable", "备份没有写出数据库页。");
    const saved = new DatabaseSync(temporary);
    try {
      const check = z
        .object({ integrity_check: z.literal("ok") })
        .safeParse(saved.prepare("PRAGMA integrity_check").get());
      if (!check.success)
        throw new AppError("unavailable", "备份完整性检查未通过。");
      // A portable backup is a self-contained file; future read-only inspection needs no WAL sidecars.
      saved.exec("PRAGMA journal_mode=DELETE");
    } finally {
      saved.close();
    }
    flushFile(temporary);
    renameSync(temporary, destinationPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    source.close();
  }
}

/** Writes the backup onto an isolated database file with the same SQLite backup API. */
export async function restoreDatabase(
  backupFile: string,
  destinationFile: string,
) {
  await backupDatabase(backupFile, destinationFile);
}

const requestName = "pending-restore.json";
const resultName = "restore-result.json";
const requestSchema = z
  .object({
    version: z.literal(1),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("previous") }).strict(),
      z
        .object({
          kind: z.literal("file"),
          path: z.string().min(1).max(4096),
        })
        .strict(),
    ]),
  })
  .strict();
const resultSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["applied", "failed"]),
    message: z.string().max(500),
  })
  .strict();

export function inspectBackup(file: string) {
  regularFile(file);
  try {
    const saved = new DatabaseSync(file, { readOnly: true });
    try {
      const check = z
        .object({ integrity_check: z.literal("ok") })
        .safeParse(saved.prepare("PRAGMA integrity_check").get());
      if (!check.success)
        throw new AppError("unavailable", "备份完整性检查未通过。");
      if (saved.prepare("PRAGMA foreign_key_check").all().length)
        throw new AppError("invalid_input", "备份存在失效的数据关联，未恢复。");
      const version = z
        .object({ user_version: z.number() })
        .parse(saved.prepare("PRAGMA user_version").get()).user_version;
      if (version > maxDatabaseVersion)
        throw new AppError("unavailable", "备份版本高于当前应用，未恢复。");
      if (
        !saved
          .prepare(
            "SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='meta'",
          )
          .get()
      )
        throw new AppError("invalid_input", "这不是本应用的数据库备份。");
      if (version < minDatabaseVersion)
        throw new AppError("invalid_input", "不支持这份备份的数据库版本。");
      return version;
    } finally {
      saved.close();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_input", "无法读取这份备份。");
  }
}
function pendingLabel(dataDirectory: string) {
  const parsed = requestSchema.safeParse(readJson(dataDirectory, requestName));
  if (!parsed.success) return null;
  const label =
    parsed.data.source.kind === "previous"
      ? "替换前的数据库"
      : basename(parsed.data.source.path);
  return label.slice(0, 240);
}
function lastNotice(dataDirectory: string) {
  const parsed = resultSchema.safeParse(readJson(dataDirectory, resultName));
  return parsed.success ? parsed.data.message : "";
}

export function readBackupStatus(
  dataDirectory: string,
  applicationDirectory?: string,
): BackupStatus {
  rejectProtectedData(dataDirectory, applicationDirectory);
  return {
    pending: pendingLabel(dataDirectory) !== null,
    pendingLabel: pendingLabel(dataDirectory),
    previousAvailable: previousAvailable(dataDirectory),
    notice: lastNotice(dataDirectory),
  };
}

/** Saves a consistent snapshot outside the data directory. An existing external file is replaced. */
export async function saveDatabaseBackup(
  dataDirectory: string,
  destinationFile: string,
  applicationDirectory?: string,
) {
  rejectProtectedData(dataDirectory, applicationDirectory);
  const selected = outsideData(
    dataDirectory,
    destinationFile,
    true,
    applicationDirectory,
  );
  const destination = realDestination(selected, applicationDirectory);
  if (
    isApplicationPath(destination, applicationDirectory) ||
    isInside(dataDirectory, destination)
  )
    throw new AppError("unauthorized", "备份目标解析到了不允许写入的目录。");
  if (existsSync(destination)) {
    const info = lstatSync(destination);
    if (info.isSymbolicLink() || !info.isFile())
      throw new AppError("invalid_input", "备份目标必须是普通文件。");
  }
  const live = join(resolve(dataDirectory), "aster.sqlite");
  if (!existsSync(live))
    throw new AppError("not_found", "当前没有可备份的数据库。");
  const temporary = join(
    dirname(destination),
    `.backup-${randomBytes(4).toString("hex")}.sqlite`,
  );
  try {
    await backupDatabase(live, temporary);
    // Replace one directory entry atomically; never borrow a user's .replaced file.
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return basename(destination);
}

export function scheduleRestore(
  dataDirectory: string,
  source: { kind: "file"; path: string } | { kind: "previous" },
  applicationDirectory?: string,
) {
  rejectProtectedData(dataDirectory, applicationDirectory);
  if (source.kind === "file") {
    const path = outsideData(
      dataDirectory,
      source.path,
      false,
      applicationDirectory,
    );
    regularFile(path);
    if (isApplicationPath(realpathSync(path), applicationDirectory))
      throw new AppError("unauthorized", "不能使用已安装程序目录。");
    inspectBackup(path);
    writeJson(resolve(dataDirectory), requestName, {
      version: 1,
      source: { kind: "file", path },
    });
  } else {
    const path = previousPath(dataDirectory);
    if (!previousAvailable(dataDirectory))
      throw new AppError("not_found", "没有可改回的上一份数据库。");
    inspectBackup(path);
    writeJson(resolve(dataDirectory), requestName, {
      version: 1,
      source: { kind: "previous" },
    });
  }
  rmSync(join(resolve(dataDirectory), resultName), { force: true });
  return readBackupStatus(dataDirectory, applicationDirectory);
}
function recordFailure(dataDirectory: string, message: string) {
  const text = message.slice(0, 500);
  writeJson(dataDirectory, resultName, {
    version: 1,
    status: "failed",
    message: text,
  });
  rmSync(join(dataDirectory, requestName), { force: true });
  return text;
}

const journalName = "restore-transaction.json";
const journalSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    hadLive: z.boolean(),
    phase: z.enum(["prepared", "installed"]),
  })
  .strict();
type RestoreJournal = z.infer<typeof journalSchema>;
function restorePaths(directory: string, id: string) {
  return {
    live: join(directory, "aster.sqlite"),
    previous: previousPath(directory),
    staged: join(directory, `.restore-next-${id}.sqlite`),
    displaced: join(directory, `.restore-displaced-${id}.sqlite`),
    prior: join(directory, `.restore-prior-${id}.sqlite`),
    rejected: join(directory, `.restore-rejected-${id}.sqlite`),
  };
}

/** Repeatable recovery before Store opens: no model/queue replay and no empty replacement DB. */
function finishRestore(
  directory: string,
  journal: RestoreJournal,
  failure?: string,
) {
  const p = restorePaths(directory, journal.id);
  for (const path of Object.values(p)) internalFile(path);
  if (
    (journal.phase === "prepared" && internalFile(p.prior)) ||
    (!journal.hadLive &&
      (internalFile(p.displaced) || internalFile(p.prior))) ||
    (journal.phase === "installed" &&
      (internalFile(p.staged) || internalFile(p.rejected)))
  )
    throw new AppError(
      "unavailable",
      "恢复阶段与现场文件不一致，所有副本已保留。",
    );
  if (journal.phase === "prepared") {
    if (internalFile(p.displaced)) {
      inspectBackup(p.displaced);
      if (internalFile(p.live)) {
        if (internalFile(p.rejected))
          throw new AppError(
            "unavailable",
            "恢复现场状态冲突，所有副本已保留。",
          );
        renameSync(p.live, p.rejected);
      }
      removeSidecars(p.live);
      renameSync(p.displaced, p.live);
    } else if (journal.hadLive) {
      if (!internalFile(p.live))
        throw new AppError(
          "unavailable",
          "原数据库恢复位置无法确认，禁止创建空库。",
        );
      inspectBackup(p.live);
    } else if (internalFile(p.live)) {
      if (internalFile(p.staged) || internalFile(p.rejected))
        throw new AppError("unavailable", "恢复现场状态冲突，所有副本已保留。");
      renameSync(p.live, p.rejected);
    }
    recordFailure(
      directory,
      failure ??
        "恢复在提交前中断，已恢复替换前的数据库；没有重新执行恢复请求。",
    );
  } else {
    inspectBackup(p.live);
    if (journal.hadLive) {
      if (internalFile(p.displaced)) {
        inspectBackup(p.displaced);
        if (internalFile(p.previous)) {
          if (internalFile(p.prior))
            throw new AppError(
              "unavailable",
              "上一份数据库的归属冲突，所有副本已保留。",
            );
          checkpoint(p.previous);
          renameSync(p.previous, p.prior);
        }
        removeSidecars(p.previous);
        renameSync(p.displaced, p.previous);
      } else if (!internalFile(p.previous))
        throw new AppError(
          "unavailable",
          "替换前的数据库尚未找到，恢复现场已保留。",
        );
      inspectBackup(p.previous);
    }
    writeJson(directory, resultName, {
      version: 1,
      status: "applied",
      message:
        "已用备份替换聊天数据库。替换前的库留在 aster.sqlite.previous。旧的排队任务不会自动重跑；定时任务已暂停，Webhook 密钥、目录授权已清除，自动记忆和旧条件审批已关闭。Jev 等本机模型连接配置保持不变，历史审批不会复用。继续聊天会建立新模型会话并按需读取恢复的历史。电脑工作文件、浏览器资料和桌面偏好没有更换。",
    });
    rmSync(join(directory, requestName), { force: true });
  }
  for (const path of [p.staged, p.rejected, p.prior]) {
    rmSync(path, { force: true });
    removeSidecars(path);
  }
  if (internalFile(p.displaced))
    throw new AppError("unavailable", "原库尚未归位，恢复日志与副本已保留。");
  removeSidecars(p.displaced);
  rmSync(join(directory, journalName), { force: true });
}

function recoverRestore(directory: string) {
  if (!internalFile(join(directory, journalName))) return false;
  let journal: RestoreJournal;
  try {
    journal = journalSchema.parse(readJson(directory, journalName));
  } catch {
    throw new AppError(
      "unavailable",
      "恢复日志损坏，文件现场已保留；请修复后再启动，未打开或创建数据库。",
    );
  }
  try {
    finishRestore(directory, journal);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "unavailable",
      "恢复文件操作未完成，日志和副本已保留。请检查磁盘空间和文件占用后重新启动。",
    );
  }
  return true;
}

/**
 * Applies a scheduled restore before the worker opens the database.
 * A failed request is discarded so the next start does not retry it.
 */
export async function applyPendingRestore(dataDirectory: string) {
  const directory = resolve(dataDirectory);
  rejectProtectedData(directory);
  if (recoverRestore(directory)) return readBackupStatus(directory);
  const requestPath = join(directory, requestName);
  const live = join(directory, "aster.sqlite");
  if (
    !internalFile(live) &&
    readdirSync(directory).some((name) =>
      /^\.restore-displaced-.*\.sqlite$/.test(name),
    )
  )
    throw new AppError(
      "unavailable",
      "发现未确认的旧恢复副本，已停止启动以避免创建空库。",
    );
  if (!internalFile(requestPath)) return readBackupStatus(directory);
  let parsed: z.infer<typeof requestSchema>;
  try {
    parsed = requestSchema.parse(readJson(directory, requestName));
  } catch {
    recordFailure(directory, "恢复请求无法读取，未替换数据库。");
    return readBackupStatus(directory);
  }
  const source =
    parsed.source.kind === "previous"
      ? previousPath(directory)
      : parsed.source.path;
  const journal: RestoreJournal = {
    version: 1,
    id: randomUUID(),
    hadLive: internalFile(live),
    phase: "prepared",
  };
  const p = restorePaths(directory, journal.id);
  try {
    if (parsed.source.kind === "file") {
      const path = outsideData(directory, source, false);
      if (isApplicationPath(realpathSync(path)))
        throw new AppError("unauthorized", "不能使用已安装程序目录。");
    } else if (!previousAvailable(directory))
      throw new AppError("not_found", "没有可改回的上一份数据库。");
    inspectBackup(source);
    await copyReadOnly(source, p.staged);
    // The source stays immutable and the restore journal retains the live file.
    const staged = new Store(p.staged, { backupBeforeUpgrade: false });
    try {
      staged.prepareRestoredSnapshot();
    } finally {
      staged.close();
    }
    checkpoint(p.staged);
    removeSidecars(p.staged);
    inspectBackup(p.staged);
    flushFile(p.staged);
    checkpoint(live);
    writeJson(directory, journalName, journal);
    if (journal.hadLive) {
      removeSidecars(live);
      renameSync(live, p.displaced);
    }
    removeSidecars(live);
    renameSync(p.staged, live);
    writeJson(directory, journalName, { ...journal, phase: "installed" });
    recoverRestore(directory);
  } catch (error) {
    if (internalFile(join(directory, journalName))) {
      // The durable phase, not the last in-memory statement, decides rollback versus finish.
      // A second failure preserves the journal and prevents Store from opening.
      const durable = journalSchema.parse(readJson(directory, journalName));
      if (durable.phase === "prepared")
        finishRestore(
          directory,
          durable,
          error instanceof AppError
            ? error.message
            : "恢复未能提交，已回到替换前的数据库。",
        );
      else
        throw new AppError(
          "unavailable",
          "备份已替换，收尾尚未完成；原库和恢复日志已保留。请检查文件占用或磁盘空间后重新启动。",
        );
    } else {
      rmSync(p.staged, { force: true });
      rmSync(`${p.staged}.partial`, { force: true });
      removeSidecars(p.staged);
      removeSidecars(`${p.staged}.partial`);
      recordFailure(
        directory,
        error instanceof AppError
          ? error.message
          : "恢复失败，仍使用原来的数据库。",
      );
    }
  }
  return readBackupStatus(directory);
}
