import { z } from "zod";

export const diagramInput = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    source: z.string().min(1).max(12_000),
  })
  .strict();
export const diagramResult = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    state: z.enum(["ready", "error", "closed"]),
    error: z.string().max(500).optional(),
  })
  .strict();
export const diagramExportRequest = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    type: z.literal("export"),
  })
  .strict();
export const diagramSvgMessage = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    type: z.literal("svg"),
    svg: z.string().min(1).max(2_000_000),
  })
  .strict();
export const diagramExportError = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    type: z.literal("export-error"),
    error: z.string().max(500),
  })
  .strict();
export function diagramSourceError(source: string): string | null {
  if (!source.trim() || source.length > 12_000) return "图表需为 1–12,000 字符";
  if (/%%\s*\{|^\s*---/m.test(source))
    return "图表不允许覆盖预览配置，请移除 frontmatter 或初始化指令";
  return null;
}
