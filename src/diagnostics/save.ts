import { lstat, realpath, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { diagnosticsSchema, type Diagnostics } from "../shared/diagnostics.js";

async function checkTarget(path: string) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error("诊断文件目标必须是普通 JSON 文件，不能是链接或目录。");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
}

/** The selected file is replaced atomically; cancellation before rename leaves it intact. */
export async function saveDiagnostics(
  path: string,
  report: Diagnostics,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (extname(path).toLowerCase() !== ".json")
    throw Error("诊断报告只能保存为 .json 文件。");
  const directory = await realpath(dirname(resolve(path)));
  const target = join(directory, basename(path));
  await checkTarget(target);
  const content =
    JSON.stringify(diagnosticsSchema.parse(report), null, 2) + "\n";
  if (Buffer.byteLength(content) > 128 * 1024)
    throw Error("诊断报告超过 128 KiB，未保存。");
  const temporary = join(directory, `.aster-diagnostic-${randomUUID()}.tmp`);
  let committed = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal.throwIfAborted();
    await checkTarget(target);
    if ((await realpath(dirname(resolve(path)))) !== directory)
      throw Error("保存目录在操作期间发生变化，未替换文件。");
    signal.throwIfAborted();
    await rename(temporary, target);
    committed = true;
  } finally {
    if (!committed)
      await unlink(temporary).catch((error: unknown) => {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      });
  }
}
