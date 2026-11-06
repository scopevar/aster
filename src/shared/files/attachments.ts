import { z } from "zod";

export const maxAttachmentBytes = 25 * 1024 * 1024;
export const maxAttachmentsPerMessage = 8;
export const attachmentAccept =
  ".txt,.md,.json,.log,.ts,.tsx,.js,.jsx,.py,.html,.css,.xml,.yaml,.yml,.sql,.csv,.tsv,.pdf,.docx,.xlsx,.xls,.png,.jpg,.jpeg,.webp,.wav,.mp3,.ogg,.m4a,.mp4,.webm";
export const attachmentInputSchema = z
  .object({
    id: z.uuid(),
    conversationId: z.uuid(),
    name: z
      .string()
      .min(1)
      .max(240)
      .refine((value) => !/[\\/\u0000-\u001f]/.test(value), "文件名无效。"),
  })
  .strict();
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;
export const attachmentSchema = attachmentInputSchema.extend({
  kind: z.enum([
    "text",
    "image",
    "pdf",
    "docx",
    "table",
    "audio",
    "video",
    "file",
  ]),
  mime: z.enum([
    "text/plain",
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
    "text/tab-separated-values",
    "audio/wav",
    "audio/mpeg",
    "audio/ogg",
    "audio/mp4",
    "video/mp4",
    "video/webm",
    "application/octet-stream",
  ]),
  size: z.number().int().nonnegative().max(maxAttachmentBytes),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int(),
  messageId: z.uuid().nullable(),
});
export type Attachment = z.infer<typeof attachmentSchema>;
export const attachmentAccessSchema = z
  .object({ id: z.uuid(), conversationId: z.uuid() })
  .strict();
export type AttachmentAccess = z.infer<typeof attachmentAccessSchema>;
export const attachmentContentSchema = z.object({
  attachment: attachmentSchema,
  data: z.string().max(Math.ceil(maxAttachmentBytes / 3) * 4),
});
export type AttachmentContent = z.infer<typeof attachmentContentSchema>;
export interface AgentAttachment {
  id: string;
  name: string;
  path: string;
  kind: Attachment["kind"];
}
