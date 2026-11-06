import { workerRoutes } from "../shared/protocol.js";
import type { DocumentReader } from "../documents/reader.js";
import {
  attachmentAccessSchema,
  attachmentInputSchema,
  maxAttachmentBytes,
} from "../shared/files/attachments.js";
import {
  backupStatusSchema,
  backupWorkerRequestSchema,
} from "../shared/backup.js";
import { AppError } from "../shared/core.js";
import { officePreviewRequestSchema } from "../shared/files/office.js";
import { templatesQuerySchema } from "../shared/templates/templates.js";
import { portableTemplate } from "../shared/templates/portable-template.js";
import {
  readBackupStatus,
  saveDatabaseBackup,
  scheduleRestore,
} from "../storage/backup/backup.js";
import type { WorkerRoute } from "./http-routes.js";
import { jsonRoute, manualPost, reply, whileConnected } from "./http-routes.js";
type Dependencies = {
  accountDir: string | undefined;
  closing: boolean;
  pdf: DocumentReader | undefined;
};
export function resourceRoutes(deps: Dependencies): readonly WorkerRoute[] {
  let attachmentTransfers = 0;
  return [
    manualPost(
      workerRoutes.backup,
      backupWorkerRequestSchema,
      undefined,
      async (ctx, read) => {
        if (ctx.url.search)
          throw new AppError("invalid_input", "备份接口不接受额外参数。");
        if (!deps.accountDir)
          throw new AppError("unavailable", "后台尚未就绪或正在关闭。");
        const dataDir = deps.accountDir;
        const input = await read();
        if (input.action === "save") {
          const name = await saveDatabaseBackup(dataDir, input.path);
          reply(
            ctx.response,
            200,
            backupStatusSchema.parse({
              ...readBackupStatus(dataDir),
              notice: `已保存：${name}。这份文件含数据库内的附件，不含 Microsandbox 工作文件和桌面偏好。`,
            }),
          );
          return;
        }
        if (
          input.action === "schedule" ||
          input.action === "schedule-previous"
        ) {
          const status = scheduleRestore(
            dataDir,
            input.action === "schedule"
              ? { kind: "file", path: input.path }
              : { kind: "previous" },
          );
          reply(
            ctx.response,
            200,
            backupStatusSchema.parse({
              ...status,
              notice: `已安排下次启动后台时恢复${status.pendingLabel ?? "所选备份"}。在此之前写入的聊天会被这份备份替换。请先停止后台再重新打开。`,
            }),
          );
          return;
        }
        reply(
          ctx.response,
          200,
          backupStatusSchema.parse(readBackupStatus(dataDir)),
        );
      },
    ),
    {
      method: "ANY",
      path: workerRoutes.attachmentsPrefix,
      match: "prefix",
      bodyLimit: maxAttachmentBytes,
      enabled: undefined,
      run: async (ctx) => {
        if (attachmentTransfers >= 2)
          throw new AppError("capacity", "附件传输繁忙，请稍后重试。");
        attachmentTransfers++;
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            attachmentTransfers--;
          }
        };
        ctx.response.once("finish", release);
        ctx.response.once("close", release);
        const { request, response, url } = ctx;
        if (
          request.method === "POST" &&
          url.pathname === workerRoutes.attachmentsUpload
        ) {
          let name: string;
          try {
            name = decodeURIComponent(
              String(request.headers["x-file-name"] ?? ""),
            );
          } catch {
            throw new AppError("invalid_input", "附件名称编码无效。");
          }
          const input = attachmentInputSchema.parse({
            id: request.headers["x-attachment-id"],
            conversationId: request.headers["x-conversation-id"],
            name,
          });
          let total = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            ctx.signal.throwIfAborted();
            const bytes = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(String(chunk));
            total += bytes.length;
            if (total > maxAttachmentBytes)
              throw new AppError("capacity", "单个附件最多 25 MiB。");
            chunks.push(bytes);
          }
          if (request.aborted || deps.closing || ctx.signal.aborted)
            throw new AppError("unavailable", "上传已中断，附件未保存。");
          reply(
            response,
            200,
            ctx.store.files.registerAttachment(input, Buffer.concat(chunks)),
          );
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname === workerRoutes.attachmentsContent
        ) {
          const input = attachmentAccessSchema.parse({
            id: url.searchParams.get("id"),
            conversationId: url.searchParams.get("conversationId"),
          });
          const content = ctx.store.files.attachmentContent(
            input.conversationId,
            input.id,
          );
          reply(response, 200, {
            attachment: content.attachment,
            data: Buffer.from(content.bytes).toString("base64"),
          });
          return;
        }
        throw new AppError("not_found", "未知附件接口。");
      },
    },
    manualPost(
      workerRoutes.documentsPreview,
      officePreviewRequestSchema,
      undefined,
      async (ctx, read) => {
        if (!deps.pdf) throw new AppError("unavailable", "文档服务未就绪。");
        const reader = deps.pdf;
        const input = await read();
        const file = ctx.store.files.attachmentContent(
          input.conversationId,
          input.id,
        );
        const kind = file.attachment.kind;
        if (kind !== "docx" && kind !== "table")
          throw new AppError("invalid_input", "此预览只支持 DOCX 和表格。");
        await whileConnected(ctx.response, ctx.signal, async (signal) => {
          const result = await reader.readOffice(
            file.bytes,
            file.attachment.name,
            kind,
            input.operation,
            signal,
          );
          signal.throwIfAborted();
          // Closing/deleting the owning conversation must not return stale data to a later view.
          ctx.store.files.attachmentContent(input.conversationId, input.id);
          reply(ctx.response, 200, result);
        });
      },
    ),
    jsonRoute(
      workerRoutes.templatesQuery,
      templatesQuerySchema,
      undefined,
      async (query, ctx) => {
        if (query.kind === "export") {
          const draft = ctx.store.templateOperations.templateDraft(query.id);
          if (draft.revision !== query.revision)
            throw new AppError("conflict", "模板已改变，请重新预览后导出。");
          reply(ctx.response, 200, {
            kind: query.kind,
            data: portableTemplate(draft.payload, query.selection),
          });
          return;
        }
        const data =
          query.kind === "local"
            ? ctx.store.templateOperations.localTemplates()
            : ctx.store.templateOperations.templateDraft(query.id);
        reply(ctx.response, 200, { kind: query.kind, data });
      },
    ),
  ];
}
