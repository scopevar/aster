import { z } from "zod";
import { attachmentInputSchema, attachmentSchema } from "./attachments.js";
import { pdfOperationSchema, pdfResultSchema } from "./documents.js";
import { officeReadOperationSchema, officeResultSchema } from "./office.js";

export const fileOperationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("document"),
      grantId: z.uuid(),
      path: z.string().min(1).max(4096),
      operation: z
        .union([pdfOperationSchema, officeReadOperationSchema])
        .describe(
          "Parse a granted PDF with info/text/render (one-based page), DOCX with word.info/word.text/word.image (zero-based image index), or XLSX/XLS/CSV/TSV with table.info/table.range (zero-based sheet, one-based row/column). PDF render returns a native image and English/Simplified Chinese OCR where applicable. Table formulas are NOT recalculated. Parsing is bounded and cancellable; compare content hashes across reads.",
        ),
    })
    .strict(),
  z.object({ action: z.literal("grants") }).strict(),
  z
    .object({
      action: z.literal("list"),
      grantId: z.uuid(),
      path: z.string().max(4096),
      offset: z.number().int().min(0).max(9900).default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal("read"),
      grantId: z.uuid(),
      path: z.string().min(1).max(4096),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
      offset: z.number().int().nonnegative().max(26214400).default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal("save"),
      name: attachmentInputSchema.shape.name,
      encoding: z.enum(["utf8", "base64"]),
      content: z.string().max(512 * 1024),
    })
    .strict(),
]);
export const fileRequestSchema = z
  .object({
    callId: z.string().min(1).max(160),
    operation: fileOperationSchema,
  })
  .strict();
export const fileListResultSchema = z
  .object({
    action: z.literal("list"),
    entries: z
      .array(
        z
          .object({
            name: z.string(),
            kind: z.enum(["file", "directory", "blocked"]),
          })
          .strict(),
      )
      .max(100),
    nextOffset: z.number().int().nullable(),
  })
  .strict();
export const fileResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("document"),
      name: z.string().min(1).max(240),
      hash: z.string(),
      result: z.union([pdfResultSchema, officeResultSchema]),
    })
    .strict(),
  z
    .object({
      action: z.literal("grants"),
      grants: z
        .array(z.object({ id: z.uuid(), root: z.string() }).strict())
        .max(8),
    })
    .strict(),
  fileListResultSchema,
  z
    .object({
      action: z.literal("read"),
      encoding: z.enum(["utf8", "base64"]),
      content: z.string().max(128 * 1024),
      size: z.number().int().nonnegative(),
      hash: z.string(),
      nextOffset: z.number().int().nullable(),
    })
    .strict(),
  z
    .object({ action: z.literal("save"), attachment: attachmentSchema })
    .strict(),
]);
export type FileRequest = z.infer<typeof fileRequestSchema>;
export type FileResult = z.infer<typeof fileResultSchema>;
