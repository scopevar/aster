import { z } from "zod";
import { officeReadOperationSchema, officeResultSchema } from "./office.js";
import { videoOperationSchema, videoResultSchema } from "./video.js";

const id = z.uuid();
const page = z.number().int().min(1).max(1000);
export const documentOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), after: id.optional() }).strict(),
  z.object({ action: z.literal("info"), id }).strict(),
  z.object({ action: z.literal("text"), id, page }).strict(),
  z.object({ action: z.literal("render"), id, page }).strict(),
  ...officeReadOperationSchema.options.map((schema) => schema.extend({ id })),
  ...videoOperationSchema.options.map((schema) => schema.extend({ id })),
]);
export type DocumentOperation = z.infer<typeof documentOperationSchema>;
export const pdfOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("info") }).strict(),
  z.object({ action: z.literal("text"), page }).strict(),
  z.object({ action: z.literal("render"), page }).strict(),
]);
export type PdfOperation = z.infer<typeof pdfOperationSchema>;
export const pdfResultSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("info"), pages: page }).strict(),
  z
    .object({
      action: z.literal("text"),
      pages: page,
      page,
      text: z.string().max(120000),
    })
    .strict(),
  z
    .object({
      action: z.literal("render"),
      pages: page,
      page,
      width: z.number().int().positive().max(1800),
      height: z.number().int().positive().max(1800),
      image: z.string().max(4 * 1024 * 1024),
      ocr: z
        .discriminatedUnion("status", [
          z.object({
            status: z.literal("ready"),
            language: z.literal("eng+chi_sim"),
            text: z.string().max(120000),
            confidence: z.number().min(0).max(100),
          }),
          z.object({
            status: z.literal("failed"),
            reason: z.string().max(240),
          }),
        ])
        .optional(),
    })
    .strict(),
]);
export type PdfResult = z.infer<typeof pdfResultSchema>;
export const documentSummarySchema = z.object({
  id,
  kind: z.enum(["pdf", "docx", "table", "video"]),
  name: z.string().min(1).max(240),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(25 * 1024 * 1024),
});
export const documentResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      documents: z.array(documentSummarySchema).max(32),
      next: id.nullable(),
    })
    .strict(),
  ...pdfResultSchema.options.map((schema) =>
    schema.extend({ id, name: z.string().min(1).max(240) }),
  ),
  ...officeResultSchema.options.map((schema) =>
    schema.extend({ id, name: z.string().min(1).max(240) }),
  ),
  ...videoResultSchema.options.map((schema) =>
    schema.extend({ id, name: z.string().min(1).max(240) }),
  ),
]);
export type DocumentResult = z.infer<typeof documentResultSchema>;
export const documentRequestSchema = z
  .object({
    callId: z.string().min(1).max(160),
    operation: documentOperationSchema,
  })
  .strict();
export const documentCallSchema = z.object({
  id,
  attachmentId: id.nullable(),
  action: z.enum([
    "list",
    "info",
    "text",
    "render",
    "word.info",
    "word.text",
    "word.image",
    "table.info",
    "table.range",
    "video.info",
    "video.frame",
  ]),
  page: page.nullable(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  detail: z.string(),
});
export type DocumentCall = z.infer<typeof documentCallSchema>;
