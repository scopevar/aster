import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentAttachment } from "../shared/files/attachments.js";
import { AppError } from "../shared/core.js";
import type { Job, Store } from "../storage/store.js";

/** Immutable, derived input cache. Committed bytes and ownership remain in SQLite. */
export async function materializeAttachments(
  store: Pick<Store, "files">,
  root: string,
  workspace: string,
  job: Job,
  signal: AbortSignal,
): Promise<AgentAttachment[]> {
  signal.throwIfAborted();
  const directory = join(workspace, "attachments");
  const canonical = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const realRoot = await realpath(root);
  const realWorkspace = await realpath(workspace);
  const scope = relative(realRoot, realWorkspace);
  if (
    isAbsolute(scope) ||
    scope.startsWith("..") ||
    !scope ||
    canonical(realWorkspace) !== canonical(workspace)
  )
    throw new AppError("unauthorized", "附件工作目录指向了未授权的位置。");
  // Validate the parent before creating anything; an attachments junction may target another Bot.
  try {
    await mkdir(directory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  const directoryStat = await lstat(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    canonical(await realpath(directory)) !== canonical(directory)
  )
    throw new AppError("unauthorized", "附件目录不能指向其他位置。");
  const result: AgentAttachment[] = [];
  for (const expected of job.attachments) {
    signal.throwIfAborted();
    // Structured documents stay behind the scoped reader instead of model filesystem access.
    if (["pdf", "docx", "table"].includes(expected.kind)) {
      result.push({
        id: expected.id,
        name: expected.name,
        path: "",
        kind: expected.kind,
      });
      continue;
    }
    const { attachment, bytes } = store.files.attachmentContent(
      job.conversationId,
      expected.id,
    );
    const extensions: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "audio/wav": "wav",
      "audio/mpeg": "mp3",
      "audio/ogg": "ogg",
      "audio/mp4": "m4a",
      "video/mp4": "mp4",
      "video/webm": "webm",
      "application/octet-stream": "bin",
    };
    const extension = extensions[attachment.mime] ?? "txt";
    const path = join(directory, `${attachment.id}.${extension}`);
    const temporary = join(
      directory,
      `${attachment.id}-${randomUUID()}.partial`,
    );
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      signal.throwIfAborted();
      try {
        await link(temporary, path);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
      }
    } finally {
      await file.close();
      await unlink(temporary);
    }
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size !== attachment.size
    )
      throw new AppError("unavailable", "附件输入副本不符合预期，未交给模型。");
    const verify = await open(path, "r");
    try {
      const buffer = Buffer.alloc(attachment.size + 1);
      let count = 0;
      while (count < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await verify.read(
          buffer,
          count,
          buffer.length - count,
          count,
        );
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (
        count !== attachment.size ||
        createHash("sha256").update(buffer.subarray(0, count)).digest("hex") !==
          attachment.hash
      )
        throw new AppError("unavailable", "附件输入副本已改变，未交给模型。");
    } finally {
      await verify.close();
    }
    result.push({
      id: attachment.id,
      name: attachment.name,
      path,
      kind: attachment.kind,
    });
  }
  return result;
}
