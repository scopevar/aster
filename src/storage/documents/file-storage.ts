import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { inspectAttachment } from "../../attachments/content.js";
import {
  attachmentSchema,
  maxAttachmentBytes,
  maxAttachmentsPerMessage,
  type Attachment,
  type AttachmentInput,
} from "../../shared/files/attachments.js";
import { AppError } from "../../shared/core.js";
import { type Run } from "../../shared/chat/runs.js";
import { cloudPayloadSchema } from "../../shared/chat/cloud-chats.js";
import type { FileRequest } from "../../shared/files/files.js";
import { type Job } from "../job.js";

type Context = {
  transaction<T>(fn: () => T): T;
  requireConversation(id: string): { botId: string };
  changed(): void;
  canWrite(job: Job): boolean;
  getRun(id: string): Run | undefined;
  fingerprint(body: string): string;
};
export class FileStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly context: Context,
  ) {}

  registerAttachment(input: AttachmentInput, data: Uint8Array): Attachment {
    const content = inspectAttachment(input.name, data);
    return this.context.transaction(() => {
      this.context.requireConversation(input.conversationId);
      if (
        this.db
          .prepare("SELECT id FROM attachment_cancellations WHERE id=?")
          .get(input.id)
      )
        throw new AppError("conflict", "该附件上传已取消，请重新选择文件。");
      const old = this.db
        .prepare(
          "SELECT id,conversationId,name,kind,mime,size,hash,createdAt,messageId FROM attachments WHERE id=?",
        )
        .get(input.id);
      if (old) {
        const existing = attachmentSchema.parse(old);
        if (
          existing.conversationId !== input.conversationId ||
          existing.hash !== content.hash ||
          existing.name !== input.name
        )
          throw new AppError("conflict", "相同附件编号不能对应不同内容。");
        return existing;
      }
      if (
        this.listAttachments(input.conversationId, null).length >=
        maxAttachmentsPerMessage
      )
        throw new AppError("capacity", "每条消息最多附加 8 个文件。");
      const total = z
        .object({ bytes: z.number() })
        .parse(
          this.db
            .prepare("SELECT COALESCE(sum(size),0) AS bytes FROM attachments")
            .get(),
        ).bytes;
      if (total + data.byteLength > 1024 * 1024 * 1024)
        throw new AppError("capacity", "附件存储已达到 1 GiB 上限。");
      const attachment = {
        ...input,
        ...content,
        createdAt: Date.now(),
        messageId: null,
      };
      this.db
        .prepare(
          "INSERT INTO attachments(id,conversationId,name,kind,mime,size,hash,createdAt,messageId,data) VALUES(?,?,?,?,?,?,?,?,NULL,?)",
        )
        .run(
          input.id,
          input.conversationId,
          input.name,
          content.kind,
          content.mime,
          content.size,
          content.hash,
          attachment.createdAt,
          data,
        );
      this.context.changed();
      return attachmentSchema.parse(attachment);
    });
  }

  listAttachments(
    conversationId: string,
    messageId: string | null,
  ): Attachment[] {
    const attachments = this.db
      .prepare(
        "SELECT id,conversationId,name,kind,mime,size,hash,createdAt,messageId FROM attachments WHERE conversationId=? AND messageId IS ? ORDER BY createdAt,rowid",
      )
      .all(conversationId, messageId)
      .map((row) => attachmentSchema.parse(row));
    if (attachments.length || messageId === null) return attachments;
    const row = this.db
      .prepare(
        "SELECT payload FROM cloud_chat_entities WHERE kind='message' AND entityId=? AND deleted=0",
      )
      .get(messageId);
    if (!row?.payload) return attachments;
    const payload = cloudPayloadSchema.parse(
      JSON.parse(z.string().parse(row.payload)),
    );
    return payload.kind === "message" &&
      payload.value.conversationId === conversationId
      ? payload.value.attachments
      : attachments;
  }

  attachmentContent(
    conversationId: string,
    id: string,
  ): { attachment: Attachment; bytes: Uint8Array } {
    this.context.requireConversation(conversationId);
    const row = this.db
      .prepare("SELECT * FROM attachments WHERE conversationId=? AND id=?")
      .get(conversationId, id);
    if (!row) throw new AppError("not_found", "附件已移除或不属于当前会话。");
    const bytes = z.instanceof(Uint8Array).parse(row.data);
    const attachment = attachmentSchema.parse(
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== "data")),
    );
    if (
      bytes.byteLength !== attachment.size ||
      createHash("sha256").update(bytes).digest("hex") !== attachment.hash
    )
      throw new AppError(
        "unavailable",
        "附件内容完整性检查失败，请从备份恢复。",
      );
    return { attachment, bytes };
  }

  canonicalPath(path: string) {
    const resolved = resolve(path);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  directoryGrants(conversationId: string) {
    return this.db
      .prepare(
        "SELECT id,root FROM directory_grants WHERE conversationId=? ORDER BY createdAt,rowid",
      )
      .all(conversationId)
      .map((row) => ({
        id: z.string().parse(row.id),
        root: z.string().parse(row.root),
      }));
  }

  requireFileRun(job: Job) {
    if (
      !this.context.canWrite(job) ||
      this.context.getRun(job.id)?.status !== "running"
    )
      throw new AppError("unauthorized", "运行已结束，不能继续访问文件。");
    this.context.requireConversation(job.conversationId);
  }

  fileGrantRoot(job: Job, id: string) {
    this.requireFileRun(job);
    const grant = this.directoryGrants(job.conversationId).find(
      (entry) => entry.id === id,
    );
    if (!grant)
      throw new AppError("unauthorized", "目录授权已撤销或不属于当前会话。");
    return grant.root;
  }

  saveFileTool(
    job: Job,
    callId: string,
    operation: Extract<FileRequest["operation"], { action: "save" }>,
  ) {
    this.requireFileRun(job);
    const bytes = Buffer.from(operation.content, operation.encoding);
    if (
      operation.encoding === "base64" &&
      bytes.toString("base64") !== operation.content
    )
      throw new AppError(
        "invalid_input",
        "成果内容不是规范的 base64，未保存。",
      );
    const result = this.saveAgentFile(job, operation.name, bytes, {
      callId,
      fingerprint: this.context.fingerprint(JSON.stringify(operation)),
    });
    if (!result)
      throw new AppError("unauthorized", "运行已经结束，成果未保存。");
    return result;
  }

  /** A replay is resolved before reading a source that may have changed or disappeared. */
  fileToolReplay(
    job: Job,
    callId: string,
    fingerprint: string,
  ): Attachment | null {
    this.requireFileRun(job);
    const prior = this.db
      .prepare(
        "SELECT fingerprint,attachmentId FROM file_tool_receipts WHERE runId=? AND ordinal=? AND callId=?",
      )
      .get(job.id, job.groupOrdinal ?? -1, callId);
    if (!prior) return null;
    if (prior.fingerprint !== fingerprint)
      throw new AppError("conflict", "同一文件调用编号不能改变参数。");
    return attachmentSchema.parse(
      this.db
        .prepare(
          "SELECT id,conversationId,name,kind,mime,size,hash,createdAt,messageId FROM attachments WHERE id=?",
        )
        .get(z.string().parse(prior.attachmentId)),
    );
  }

  directoryContext(conversationId: string) {
    const grants = this.directoryGrants(conversationId);
    if (!grants.length) return "";
    return `\n\n已授权读取的目录（使用 read 读取 /grants/<授权编号>/相对路径，不能绕过撤销。Shell 仅能处理已读取到 /inputs 的副本。生成文件写入 /workspace，回复中使用 [文件名](sandbox:/workspace/路径) 交付附件）：\n${grants
      .map((grant) => `- /grants/${grant.id} ${grant.root}`)
      .join("\n")}`;
  }

  readGrantedFile(
    conversationId: string,
    grantId: string,
    relativePath: string,
  ): Uint8Array {
    this.context.requireConversation(conversationId);
    if (
      !relativePath ||
      relativePath.includes("\u0000") ||
      isAbsolute(relativePath)
    )
      throw new AppError("unauthorized", "只能读取授权目录内的相对路径。");
    const grant = this.db
      .prepare("SELECT conversationId,root FROM directory_grants WHERE id=?")
      .get(grantId);
    if (!grant || grant.conversationId !== conversationId)
      throw new AppError("unauthorized", "该目录授权不属于当前会话。");
    const root = z.string().parse(grant.root);
    const lexical = resolve(root, relativePath);
    const lexicalRelative = relative(
      this.canonicalPath(root),
      this.canonicalPath(lexical),
    );
    if (
      !lexicalRelative ||
      lexicalRelative.startsWith("..") ||
      isAbsolute(lexicalRelative)
    )
      throw new AppError("unauthorized", "该路径超出了授权目录。");
    let realTarget: string;
    try {
      realTarget = realpathSync(lexical);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new AppError("not_found", "授权目录中没有这个文件。");
      throw new AppError("unavailable", "无法确认文件的实际位置。");
    }
    const realRelative = relative(
      this.canonicalPath(root),
      this.canonicalPath(realTarget),
    );
    if (
      !realRelative ||
      realRelative.startsWith("..") ||
      isAbsolute(realRelative)
    )
      throw new AppError("unauthorized", "该路径超出了授权目录。");
    const target = lstatSync(realTarget);
    if (target.isSymbolicLink() || !target.isFile())
      throw new AppError("invalid_input", "授权目录只允许读取文件。");
    if (target.size > maxAttachmentBytes)
      throw new AppError("capacity", "单个附件最多 25 MiB。");
    return readFileSync(realTarget);
  }

  saveAgentFile(
    job: Job,
    name: string,
    data: Uint8Array,
    receipt?: { callId: string; fingerprint: string },
  ): Attachment | null {
    if (!this.context.canWrite(job)) return null;
    if (!name || name.length > 240 || /[\\/\u0000-\u001f]/.test(name))
      throw new AppError("invalid_input", "成果文件名无效。");
    if (data.byteLength > maxAttachmentBytes)
      throw new AppError("capacity", "单个附件最多 25 MiB。");
    let inspected: Pick<Attachment, "size" | "kind" | "mime" | "hash">;
    try {
      inspected = inspectAttachment(name, data);
    } catch (error) {
      if (error instanceof AppError && error.code === "capacity") throw error;
      inspected = {
        size: data.byteLength,
        kind: "file",
        mime: "application/octet-stream",
        hash: createHash("sha256").update(data).digest("hex"),
      };
    }
    return this.context.transaction(() => {
      if (!this.context.canWrite(job)) return null;
      if (receipt) {
        this.requireFileRun(job);
        const prior = this.db
          .prepare(
            "SELECT fingerprint,attachmentId FROM file_tool_receipts WHERE runId=? AND ordinal=? AND callId=?",
          )
          .get(job.id, job.groupOrdinal ?? -1, receipt.callId);
        if (prior) {
          if (prior.fingerprint !== receipt.fingerprint)
            throw new AppError("conflict", "同一文件调用编号不能改变参数。");
          return attachmentSchema.parse(
            this.db
              .prepare(
                "SELECT id,conversationId,name,kind,mime,size,hash,createdAt,messageId FROM attachments WHERE id=?",
              )
              .get(z.string().parse(prior.attachmentId)),
          );
        }
        const count = z
          .number()
          .parse(
            this.db
              .prepare(
                "SELECT count(*) n FROM file_tool_receipts WHERE runId=?",
              )
              .get(job.id)?.n,
          );
        if (count >= 16)
          throw new AppError("capacity", "本轮最多保存 16 份成果文件。");
      }
      const total = z
        .object({ bytes: z.number() })
        .parse(
          this.db
            .prepare("SELECT COALESCE(sum(size),0) AS bytes FROM attachments")
            .get(),
        ).bytes;
      if (total + data.byteLength > 1024 * 1024 * 1024)
        throw new AppError("capacity", "附件存储已达到 1 GiB 上限。");
      const id = randomUUID();
      const messageId = randomUUID();
      const createdAt = Date.now();
      this.db
        .prepare(
          "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId) VALUES(?,?,?,'assistant',?,?,?)",
        )
        .run(
          messageId,
          job.botId,
          job.conversationId,
          `已保存成果文件：${name}`,
          createdAt,
          job.id,
        );
      this.db
        .prepare(
          "INSERT INTO attachments(id,conversationId,name,kind,mime,size,hash,createdAt,messageId,data) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          job.conversationId,
          name,
          inspected.kind,
          inspected.mime,
          inspected.size,
          inspected.hash,
          createdAt,
          messageId,
          data,
        );
      if (receipt)
        this.db
          .prepare("INSERT INTO file_tool_receipts VALUES(?,?,?,?,?)")
          .run(
            job.id,
            job.groupOrdinal ?? -1,
            receipt.callId,
            receipt.fingerprint,
            id,
          );
      this.context.changed();
      return attachmentSchema.parse({
        id,
        conversationId: job.conversationId,
        name,
        ...inspected,
        createdAt,
        messageId,
      });
    });
  }
}
