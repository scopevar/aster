import { z } from "zod";
import { avatarBase64, avatarColors, avatarShapes } from "../avatar.js";
import { templateDraftSchema, localTemplatesSchema } from "./templates.js";
const metadata = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(4000),
  tags: z.string().max(240),
};
export const templateOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("read"), id: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("create"),
      ...metadata,
      includeSkills: z.boolean(),
      includeRoutines: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      id: z.uuid(),
      revision: z.number().int().positive(),
      ...metadata,
    })
    .strict(),
]);
export type TemplateOperation = z.infer<typeof templateOperationSchema>;
export const templateToolRequestSchema = z
  .object({
    callId: z.string().min(1).max(200),
    operation: templateOperationSchema,
  })
  .strict();
export const templateReceiptSchema = z.object({
  action: z.enum(["create", "update"]),
  id: z.uuid(),
  revision: z.number().int().positive(),
  ...metadata,
  image: avatarBase64.nullable(),
  appearance: z
    .object({ shape: avatarShapes, color: avatarColors })
    .strict()
    .optional(),
});
export type TemplateReceipt = z.infer<typeof templateReceiptSchema>;
export const templateToolResultSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    drafts: localTemplatesSchema.shape.drafts,
  }),
  z.object({ action: z.literal("read"), draft: templateDraftSchema }),
  z.object({
    action: z.literal("create"),
    receipt: templateReceiptSchema,
    messageId: z.uuid(),
  }),
  z.object({
    action: z.literal("update"),
    receipt: templateReceiptSchema,
    messageId: z.uuid(),
  }),
]);
export type TemplateToolResult = z.infer<typeof templateToolResultSchema>;
