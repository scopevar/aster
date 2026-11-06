import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../shared/core.js";
import type { LocalWorkspaceStatus } from "../shared/local-workspace.js";
import { relocateSecretKey } from "../security/secret.js";
import { localWorkspaceDirectory } from "../platform/app-data-directory.js";

const manifestSchema = z
  .object({
    version: z.literal(1),
    source: z.string().nullable(),
    backup: z.string().nullable(),
  })
  .strict();

/** A selected legacy workspace is copied, never merged or moved. Originals stay intact. */
export class LocalWorkspace {
  readonly directory: string;
  private selection: Promise<LocalWorkspaceStatus> | undefined;
  constructor(private readonly root: string) {
    this.directory = localWorkspaceDirectory(root);
  }
  async status(): Promise<LocalWorkspaceStatus> {
    if (existsSync(this.directory)) {
      const entry = await lstat(this.directory);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new AppError(
          "conflict",
          "本地工作区必须是普通目录，原有内容未改写。",
        );
    }
    const manifest = join(this.directory, "workspace.json");
    if (existsSync(manifest)) {
      const value = manifestSchema.parse(
        JSON.parse(await readFile(manifest, "utf8")),
      );
      return {
        ready: true,
        directory: this.directory,
        sources: [],
        backup: value.backup,
      };
    }
    if (existsSync(this.directory)) {
      // Restore may temporarily displace SQLite. Its coordinator validates journals before any new database is opened.
      return {
        ready: true,
        directory: this.directory,
        sources: [],
        backup: null,
      };
    }
    const accounts = join(this.root, "accounts");
    const sources: LocalWorkspaceStatus["sources"] = [];
    if (existsSync(accounts)) {
      for (const entry of await readdir(accounts, { withFileTypes: true })) {
        if (
          !entry.isDirectory() ||
          (entry.name !== "guest" && !z.uuid().safeParse(entry.name).success)
        )
          continue;
        for (const suffix of ["", "host-v1", "cloud-v2"]) {
          const directory = join(accounts, entry.name, suffix);
          if (!existsSync(join(directory, "aster.sqlite"))) continue;
          sources.push({
            id: `${entry.name}/${suffix}`,
            label: `${entry.name === "guest" ? "访客" : `账户 ${entry.name}`}${suffix ? ` · ${suffix}` : ""}`,
            directory,
          });
        }
      }
    }
    return { ready: false, directory: this.directory, sources, backup: null };
  }
  async prepare() {
    const state = await this.status();
    if (state.ready || state.sources.length > 1) return state;
    return this.select(state.sources[0]?.id ?? null);
  }
  select(source: string | null): Promise<LocalWorkspaceStatus> {
    if (this.selection) throw new AppError("conflict", "正在准备本地工作区。");
    const operation = this.copy(source);
    this.selection = operation;
    return operation.finally(() => {
      this.selection = undefined;
    });
  }
  private async copy(source: string | null) {
    const state = await this.status();
    if (state.ready)
      throw new AppError(
        "conflict",
        "本地工作区已存在，不能覆盖或合并旧数据。",
      );
    const selected = state.sources.find((candidate) => candidate.id === source);
    if (source !== null && !selected)
      throw new AppError("invalid_input", "请选择检测到的旧数据目录。");
    const stamp = randomUUID();
    const staging = join(this.root, `.local-migration-${stamp}`);
    let backupDirectory: string | null = null;
    if (selected) {
      backupDirectory = join(this.root, "migration-backups", stamp);
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      await copyWorkspace(
        selected.directory,
        join(backupDirectory, "workspace"),
      );
      // Model credentials are device-wide and remain at their original path.
      for (const name of [
        "agent",
        "os-crypt.key",
        "os-crypt.backend",
        "safe-storage",
      ])
        if (existsSync(join(this.root, name)))
          await cp(join(this.root, name), join(backupDirectory, name), {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
      await writeFile(
        join(backupDirectory, "migration.json"),
        JSON.stringify({
          version: 1,
          source: selected.directory,
          destination: this.directory,
        }),
        { flag: "wx", mode: 0o600 },
      );
      await copyWorkspace(join(backupDirectory, "workspace"), staging);
      if (existsSync(join(selected.directory, "os-crypt.key")))
        await relocateSecretKey(selected.directory, staging, this.directory);
    } else await mkdir(staging, { mode: 0o700 });
    await writeFile(
      join(staging, "workspace.json"),
      JSON.stringify({
        version: 1,
        source: selected?.directory ?? null,
        backup: backupDirectory,
      }),
      { flag: "wx", mode: 0o600 },
    );
    // Rename publishes the complete copy. Failed migrations leave originals and backups untouched.
    await rename(staging, this.directory);
    return this.status();
  }
}

async function copyWorkspace(source: string, destination: string) {
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (path) => {
      if (path === join(source, "host-v1") || path === join(source, "cloud-v2"))
        return false;
      if (
        ["aster.sqlite", "aster.sqlite-wal", "aster.sqlite-shm"].some(
          (name) => path === join(source, name),
        )
      )
        return false;
      if ((await lstat(path)).isSymbolicLink())
        throw new AppError(
          "conflict",
          "旧数据目录包含链接，请先检查并通过备份恢复入口导入，未跟随链接复制。",
        );
      return true;
    },
  });
  const database = new DatabaseSync(join(source, "aster.sqlite"), {
    readOnly: true,
  });
  try {
    await backup(database, join(destination, "aster.sqlite"));
  } finally {
    database.close();
  }
}
