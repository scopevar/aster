import { z } from "zod";

export const officeKindSchema = z.enum(["docx", "table"]);
export type OfficeKind = z.infer<typeof officeKindSchema>;
const index = z.number().int().min(0).max(199);
export const officeReadOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("word.info") }).strict(),
  z
    .object({
      action: z.literal("word.text"),
      offset: z
        .number()
        .int()
        .min(0)
        .max(2_000_000)
        .default(0)
        .describe(
          "Zero-based character offset; start with 0 and continue using the returned next offset.",
        ),
      length: z.number().int().min(1).max(120_000).default(120_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("word.image"),
      index: z
        .number()
        .int()
        .min(0)
        .max(31)
        .describe(
          "Zero-based embedded image index: the first image is index 0. word.info.images is a count, not an index.",
        ),
    })
    .strict(),
  z.object({ action: z.literal("table.info") }).strict(),
  z
    .object({
      action: z.literal("table.range"),
      sheet: index,
      row: z.number().int().min(1).max(1_048_576),
      column: z.number().int().min(1).max(16384),
      rows: z.number().int().min(1).max(200),
      columns: z.number().int().min(1).max(200),
    })
    .strict(),
]);
export const officeOperationSchema = z.discriminatedUnion("action", [
  ...officeReadOperationSchema.options,
  z.object({ action: z.literal("word.preview") }).strict(),
]);
export const officePreviewRequestSchema = z
  .object({
    requestId: z.uuid(),
    id: z.uuid(),
    conversationId: z.uuid(),
    operation: officeOperationSchema,
  })
  .strict();
export type OfficePreviewRequest = z.infer<typeof officePreviewRequestSchema>;
export type OfficeOperation = z.infer<typeof officeOperationSchema>;
export const officeElementSchema = z.enum([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "code",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "u",
  "s",
  "sup",
  "sub",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "br",
  "hr",
]);
export type OfficeNode =
  | { kind: "text"; text: string }
  | {
      kind: "element";
      tag: z.infer<typeof officeElementSchema>;
      children: OfficeNode[];
      colspan?: number | undefined;
      rowspan?: number | undefined;
      start?: number | undefined;
    }
  | { kind: "link"; href: string | null; children: OfficeNode[] }
  | { kind: "image"; index: number; alt: string };
export const officeNodeSchema: z.ZodType<OfficeNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("text"), text: z.string().max(2_000_000) })
      .strict(),
    z
      .object({
        kind: z.literal("element"),
        tag: officeElementSchema,
        children: z.array(officeNodeSchema).max(20000),
        colspan: z.number().int().min(1).max(200).optional(),
        rowspan: z.number().int().min(1).max(10000).optional(),
        start: z.number().int().min(0).max(1000000).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("link"),
        href: z.string().max(4096).nullable(),
        children: z.array(officeNodeSchema).max(20000),
      })
      .strict(),
    z
      .object({
        kind: z.literal("image"),
        index: z.number().int().min(0).max(31),
        alt: z.string().max(2000),
      })
      .strict(),
  ]),
);
export const officeWarningSchema = z.string().max(1000);
const warnings = z.array(officeWarningSchema).max(100);
export const officeImageSchema = z
  .object({
    index: z.number().int().min(0).max(31),
    data: z
      .string()
      .max(4 * 1024 * 1024)
      .nullable(),
    error: z.string().max(1000).nullable(),
  })
  .strict();
export const sheetSummarySchema = z
  .object({
    index,
    name: z.string().max(255),
    rows: z.number().int().min(0).max(1_048_576),
    columns: z.number().int().min(0).max(16384),
    hidden: z.boolean(),
  })
  .strict();
export type SheetSummary = z.infer<typeof sheetSummarySchema>;
export const sheetCellSchema = z
  .object({
    address: z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/),
    text: z.string().max(32767),
    value: z.union([
      z.string().max(32767),
      z.number().finite(),
      z.boolean(),
      z.null(),
    ]),
    formula: z.string().max(32767).nullable(),
    error: z.boolean(),
  })
  .strict();
export const officeResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("word.info"),
      characters: z.number().int().max(2_000_000),
      images: z.number().int().max(32),
      warnings,
    })
    .strict(),
  z
    .object({
      action: z.literal("word.preview"),
      nodes: z.array(officeNodeSchema).max(20000),
      images: z.array(officeImageSchema).max(32),
      warnings,
    })
    .strict(),
  z
    .object({
      action: z.literal("word.text"),
      offset: z.number().int().nonnegative(),
      text: z.string().max(120000),
      total: z.number().int().max(2_000_000),
      next: z.number().int().nullable(),
      warnings,
    })
    .strict(),
  z
    .object({
      action: z.literal("word.image"),
      image: officeImageSchema,
      warnings,
    })
    .strict(),
  z
    .object({
      action: z.literal("table.info"),
      sheets: z.array(sheetSummarySchema).max(200),
      warnings,
    })
    .strict(),
  z
    .object({
      action: z.literal("table.range"),
      sheet: sheetSummarySchema,
      row: z.number().int().positive(),
      column: z.number().int().positive(),
      cells: z.array(z.array(sheetCellSchema).max(200)).max(200),
      warnings,
    })
    .strict(),
]);
export type OfficeResult = z.infer<typeof officeResultSchema>;
export type SheetRange = Extract<OfficeResult, { action: "table.range" }>;

/** Content links are data until a user explicitly opens one; never accept file/script/custom schemes. */
export function officeLink(value: string): string | null {
  if (value.length > 4096) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
