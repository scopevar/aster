import { existsSync } from "node:fs";
import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ownDirectory } from "../platform/directory-lease.js";
import { migrateSafeStorageKey } from "../security/secret.js";

/** No user workspaces or arbitrary paths are traversed. Every rewrap preserves
 * the original AES key, so an interrupted sequence can safely be repeated. */
export async function migrateDaemonSecrets(directory: string) {
  const lease = await ownDirectory(directory, "worker");
  try {
    const assertDirectory = async (path: string) => {
      if (!existsSync(path)) return;
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("凭据目录不是普通目录，未继续迁移。");
    };
    await assertDirectory(directory);
    await assertDirectory(join(directory, "agent"));
    const directories = [
      directory,
      join(directory, "agent"),
      join(directory, "local"),
    ];
    const accounts = join(directory, "accounts");
    await assertDirectory(accounts);
    if (existsSync(accounts)) {
      for (const entry of await readdir(accounts, { withFileTypes: true }))
        if (
          entry.isDirectory() &&
          (entry.name === "guest" || z.uuid().safeParse(entry.name).success)
        ) {
          directories.push(
            join(accounts, entry.name),
            join(accounts, entry.name, "host-v1"),
            join(accounts, entry.name, "cloud-v2"),
          );
        }
    }
    let migrated = 0;
    for (const root of directories) {
      await assertDirectory(root);
      const key = join(root, "os-crypt.key");
      if (!existsSync(key)) continue;
      const file = await lstat(key);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 16384)
        throw new Error("密钥包装文件不是有界普通文件，未继续迁移。");
      await migrateSafeStorageKey(root);
      migrated++;
    }
    return { migrated, sealedDataPreserved: true };
  } finally {
    await lease.close();
  }
}
