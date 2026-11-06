import { z } from "zod";
import { AppError } from "../core.js";

export const diagramSaveRequestSchema = z
  .object({
    svg: z.string().min(1).max(2_000_000),
  })
  .strict();
export const diagramSaveResultSchema = z
  .object({
    saved: z.boolean(),
    notice: z.string().max(500),
  })
  .strict();
export type DiagramSaveRequest = z.infer<typeof diagramSaveRequestSchema>;
export type DiagramSaveResult = z.infer<typeof diagramSaveResultSchema>;

const maxSvgChars = 2_000_000;
const blocked = [
  /<script\b/i,
  /<\/script/i,
  /javascript:/i,
  /<foreignObject\b/i,
  /<iframe\b/i,
  /<object\b/i,
  /<embed\b/i,
  /<!DOCTYPE/i,
  /<!ENTITY/i,
  /<\?/,
  /\son[a-z]+\s*=/i,
  /expression\s*\(/i,
  /@import\b/i,
  /-moz-binding\b/i,
];

/** Returns the SVG text that may be written. Rejects active content before any file call. */
export function validateDiagramSvg(svg: string): string {
  const text = svg.replace(/^\uFEFF/, "").trim();
  if (
    !text ||
    text.length > maxSvgChars ||
    Buffer.byteLength(text) > maxSvgChars
  )
    throw new AppError("invalid_input", "图表为空或超过导出大小限制。");
  if (!/^<svg(\s|>)/i.test(text) || !/<\/svg>$/i.test(text))
    throw new AppError("invalid_input", "只能导出完整的 SVG 图表。");
  if (blocked.some((pattern) => pattern.test(text)))
    throw new AppError("invalid_input", "图表包含不能导出的活动内容。");
  if (
    /(?:href|xlink:href)\s*=\s*(['"])(?!#)(?!\1)[^'"]*\1/i.test(text) ||
    /(?:href|xlink:href)\s*=\s*[^"'\s#]/i.test(text) ||
    /url\(\s*(['"]?)(?!#)/i.test(text)
  )
    throw new AppError("invalid_input", "图表包含不能导出的外部链接。");
  return text;
}
