import { snapshotUpdateSchema } from "../../shared/snapshot.js";
import { workerRoutes } from "../../shared/protocol.js";
import { dialog, shell } from "electron";
import { z } from "zod";
import {
  attachmentAccessSchema,
  attachmentInputSchema,
} from "../../shared/files/attachments.js";
import { AppError } from "../../shared/core.js";
import {
  officeLink,
  officePreviewRequestSchema,
} from "../../shared/files/office.js";
import type { DesktopHandlerContext } from "./handler-context.js";
import { parseInput } from "./ipc-result.js";
export function registerFileHandlers(
  ctx: Pick<
    DesktopHandlerContext,
    | "handle"
    | "window"
    | "draining"
    | "acceptedCommands"
    | "attachments"
    | "documents"
    | "workerCall"
    | "directoryConsent"
  >,
) {
  const { handle, acceptedCommands, attachments, documents } = ctx;
  handle("uploadAttachment", async (input, bytes) => {
    if (ctx.draining)
      throw new AppError("unavailable", "界面正在退出，附件未接受。");
    const request = attachments.upload(
      parseInput(attachmentInputSchema, input),
      parseInput(z.instanceof(Uint8Array), bytes),
    );
    acceptedCommands.add(request);
    try {
      return await request;
    } finally {
      acceptedCommands.delete(request);
    }
  });
  handle("cancelUpload", (id) => {
    attachments.cancel(parseInput(z.uuid(), id));
  });
  handle("attachmentContent", (input) =>
    attachments.content(parseInput(attachmentAccessSchema, input)),
  );
  handle("documentPreview", (input) => {
    if (ctx.draining)
      throw new AppError("unavailable", "界面正在退出，预览未接受。");
    return documents.request(parseInput(officePreviewRequestSchema, input));
  });
  handle("cancelDocumentPreview", (input) => {
    documents.cancel(parseInput(z.uuid(), input));
  });
  handle("openDocumentLink", (input) => {
    const url = officeLink(parseInput(z.string().max(4096), input));
    if (!url) throw new AppError("invalid_input", "不支持此链接地址。");
    return shell.openExternal(url);
  });
  handle("chooseDirectory", async (input) => {
    if (!ctx.window || ctx.draining)
      throw new AppError("unavailable", "窗口不可用。");
    const conversationId = parseInput(z.uuid(), input);
    const owner = ctx.window;
    const snapshot = snapshotUpdateSchema.parse(
      await ctx.workerCall(workerRoutes.snapshot, {
        conversationId,
      }),
    );
    if (
      !snapshot.changed ||
      !snapshot.snapshot.conversations.some(
        (c) => c.id === conversationId && !c.deletionPending,
      )
    )
      throw new AppError("not_found", "会话已不存在。");
    const chosen = await dialog.showOpenDialog(owner, {
      title: "选择授权读取的目录",
      properties: ["openDirectory"],
    });
    const root = chosen.filePaths[0];
    if (chosen.canceled || !root) return null;
    if (ctx.draining || ctx.window !== owner || owner.isDestroyed())
      throw new AppError("unavailable", "窗口已关闭，目录未授权。");
    return ctx.directoryConsent.issue({
      root,
      conversationId,
      epoch: snapshot.snapshot.epoch,
      owner: owner.id,
    });
  });
  handle("saveAttachment", async (input) => {
    if (!ctx.window || ctx.draining)
      throw new AppError("unavailable", "窗口不可用。");
    const request = attachments.save(
      ctx.window,
      parseInput(attachmentAccessSchema, input),
    );
    acceptedCommands.add(request);
    try {
      return await request;
    } finally {
      acceptedCommands.delete(request);
    }
  });
}
