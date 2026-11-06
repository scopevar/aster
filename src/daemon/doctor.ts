import { copyFile, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existingSecretBox } from "../security/secret.js";
import { ownDirectory } from "../platform/directory-lease.js";

async function ordinary(path: string, directory: boolean, limit = 16384) {
  try {
    const file = await lstat(path);
    if (
      file.isSymbolicLink() ||
      (directory ? !file.isDirectory() : !file.isFile() || file.size > limit)
    )
      throw new Error("凭据路径不是有界普通文件或目录。");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

/** Probe existing startup secrets, never create user files or open a database.
 * Windows OS crypt needs Local State; use a private disposable profile so even
 * Chromium's normal preference flush cannot change the original profile. */
export async function inspectDaemonCredentials(directory: string) {
  if (!(await ordinary(directory, true))) return 0;
  const leases: Awaited<ReturnType<typeof ownDirectory>>[] = [];
  try {
    for (const service of ["daemon-start", "worker", "supervisor"] as const)
      leases.push(await ownDirectory(directory, service));
    let checked = 0;
    for (const [root, name] of [
      [join(directory, "agent"), "pi-auth.sealed"],
    ] as const) {
      if (!(await ordinary(root, true))) continue;
      if (!(await ordinary(join(root, name), false, 1024 * 1024))) continue;
      if (name === "pi-auth.sealed")
        leases.push(await ownDirectory(root, "pi-auth"));
      await ordinary(join(root, "os-crypt.key"), false);
      const scratch = await mkdtemp(join(tmpdir(), "aster-credential-check-"));
      try {
        const profile = join(root, "safe-storage");
        if (await ordinary(profile, true)) {
          const state = join(profile, "Local State");
          if (await ordinary(state, false, 1024 * 1024)) {
            await mkdir(join(scratch, "safe-storage"));
            await copyFile(state, join(scratch, "safe-storage", "Local State"));
          }
        }
        const box = existingSecretBox(root, scratch);
        const file = await open(join(root, name), "r");
        try {
          JSON.parse(
            Buffer.from(await box.open(await file.readFile())).toString("utf8"),
          );
        } finally {
          await file.close();
        }
        checked++;
      } catch {
        throw new Error(
          `${name} 凭据无法解密或格式无效；请检查原系统账户、密钥环及保护上下文。原密文未改写，不要单独删除密钥。`,
        );
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    return checked;
  } finally {
    for (const lease of leases.reverse()) await lease.close();
  }
}
