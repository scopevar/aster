import { workerRoutes } from "../../shared/protocol.js";
import { dialog, type BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { readWorker, callWorker } from "../../worker/client.js";
import {
  attachmentInputSchema,
  attachmentAccessSchema,
  attachmentSchema,
  attachmentContentSchema,
  maxAttachmentBytes,
  type AttachmentAccess,
} from "../../shared/files/attachments.js";
import { AppError, failureSchema } from "../../shared/core.js";

export class DesktopAttachments {
  private uploads = new Map<string, AbortController>();
  constructor(private readonly directory: string) {}
  async upload(input: unknown, bytes: unknown) {
    const metadata = attachmentInputSchema.parse(input);
    const data = z.instanceof(Uint8Array).parse(bytes);
    if (data.byteLength > maxAttachmentBytes)
      throw new AppError("capacity", "单个附件最多 25 MiB。");
    if (this.uploads.has(metadata.id) || this.uploads.size >= 2)
      throw new AppError("capacity", "附件上传繁忙，请稍后重试。");
    const controller = new AbortController();
    this.uploads.set(metadata.id, controller);
    try {
      const endpoint = await readWorker(this.directory);
      const response = await fetch(
        `http://127.0.0.1:${endpoint.port}${workerRoutes.attachmentsUpload}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${endpoint.token}`,
            "Content-Type": "application/octet-stream",
            "x-attachment-id": metadata.id,
            "x-conversation-id": metadata.conversationId,
            "x-file-name": encodeURIComponent(metadata.name),
          },
          body: Buffer.from(data),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30000),
          ]),
        },
      );
      const value: unknown = await response.json();
      if (!response.ok) {
        const failure = z.object({ error: failureSchema }).parse(value);
        throw new AppError(failure.error.code, failure.error.message);
      }
      return attachmentSchema.parse(value);
    } finally {
      this.uploads.delete(metadata.id);
    }
  }
  cancel(id: unknown) {
    this.uploads.get(z.uuid().parse(id))?.abort();
  }
  async content(input: unknown) {
    const access = attachmentAccessSchema.parse(input);
    const query = new URLSearchParams(access);
    return attachmentContentSchema.parse(
      await callWorker(
        await readWorker(this.directory),
        `${workerRoutes.attachmentsContent}?${query}`,
      ),
    );
  }
  async save(
    window: BrowserWindow,
    access: AttachmentAccess,
  ): Promise<boolean> {
    const content = await this.content(access);
    const result = await dialog.showSaveDialog(window, {
      title: "保存附件",
      defaultPath: content.attachment.name,
      properties: ["showOverwriteConfirmation"],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, Buffer.from(content.data, "base64"));
    return true;
  }
}
