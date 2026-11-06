import { app, dialog } from "electron";
import {
  lstat,
  open,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/core.js";
import {
  templateFileRequestSchema,
  templatePayloadSchema,
  templatesResponseSchema,
} from "../../shared/templates/templates.js";
import { workerRoutes } from "../../shared/protocol.js";
import type { DesktopHandlerContext } from "./handler-context.js";
import { parseInput } from "./ipc-result.js";

export function registerTemplateFileHandlers(
  ctx: Pick<
    DesktopHandlerContext,
    "handle" | "window" | "draining" | "workerCall"
  >,
  dataDirectory: string,
) {
  ctx.handle("templateFile", async (input) => {
    const request = parseInput(templateFileRequestSchema, input);
    const owner = ctx.window;
    if (!owner || owner.isDestroyed() || ctx.draining)
      throw new AppError("unavailable", "窗口不可用。");
    const filters = [{ name: "Aster 模板", extensions: ["json"] }];
    const cancelled = { cancelled: true, payload: null };
    if (request.action === "open") {
      const choice = await dialog.showOpenDialog(owner, {
        title: "导入模板文件",
        filters,
        properties: ["openFile"],
      });
      if (choice.canceled || !choice.filePaths[0]) return cancelled;
      if (ctx.draining || ctx.window !== owner || owner.isDestroyed())
        throw new AppError("unavailable", "窗口已关闭，未导入模板。");
      const file = await open(choice.filePaths[0], "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
          throw new AppError("invalid_input", "模板文件最多 2 MiB。");
        const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
        let total = 0;
        while (total < bytes.length) {
          const { bytesRead } = await file.read(
            bytes,
            total,
            bytes.length - total,
          );
          if (!bytesRead) break;
          total += bytesRead;
        }
        if (total > 2 * 1024 * 1024)
          throw new AppError("invalid_input", "模板文件最多 2 MiB。");
        let value: unknown;
        try {
          value = JSON.parse(bytes.subarray(0, total).toString("utf8"));
        } catch {
          throw new AppError("invalid_input", "模板文件不是有效 JSON。");
        }
        const payload = parseInput(
          templatePayloadSchema,
          value,
          "模板文件格式不符合约定。",
        );
        return { cancelled: false, payload };
      } finally {
        await file.close();
      }
    }
    const response = templatesResponseSchema.parse(
      await ctx.workerCall(workerRoutes.templatesQuery, {
        kind: "export",
        id: request.id,
        revision: request.revision,
        selection: request.selection,
      }),
    );
    if (response.kind !== "export")
      throw new AppError("internal", "模板导出结果无效。");
    const choice = await dialog.showSaveDialog(owner, {
      title: "导出模板文件",
      filters,
      defaultPath: "aster-template.json",
      properties: ["showOverwriteConfirmation"],
    });
    if (choice.canceled || !choice.filePath) return cancelled;
    if (ctx.draining || ctx.window !== owner || owner.isDestroyed())
      throw new AppError("unavailable", "窗口已关闭，未导出模板。");
    if (extname(choice.filePath).toLowerCase() !== ".json")
      throw new AppError("invalid_input", "模板只能导出为 JSON 文件。");
    const parent = await realpath(dirname(choice.filePath));
    const target = join(parent, basename(choice.filePath));
    for (const protectedDirectory of [
      await realpath(dataDirectory),
      ...(app.isPackaged ? [dirname(process.execPath)] : []),
    ]) {
      const fromRoot = relative(protectedDirectory, target);
      if (
        !isAbsolute(fromRoot) &&
        fromRoot !== ".." &&
        !fromRoot.startsWith(`..${sep}`)
      )
        throw new AppError("unauthorized", "模板不能写入应用数据或安装目录。");
    }
    try {
      const existing = await lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink())
        throw new AppError("invalid_input", "模板必须保存为普通文件。");
    } catch (cause) {
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      )
        throw cause;
    }
    const temporary = join(parent, `.aster-template-${randomUUID()}.partial`);
    try {
      await writeFile(temporary, JSON.stringify(response.data, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((cause: unknown) => {
        if (
          !(
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "ENOENT"
          )
        )
          throw cause;
      });
    }
    return { cancelled: false, payload: null };
  });
}
