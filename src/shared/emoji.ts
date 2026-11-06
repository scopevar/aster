import { z } from "zod";
import data from "emojibase-data/zh/compact.json" with { type: "json" };

/** Wire normalization and the accepted Unicode set; labels and picker groups live in presentation. */
export const comparisonKey = (unicode: string) =>
  unicode.replace(/\uFE0F/g, "");
const canonicalVariants = new Map(
  ["👍", "👎", "❤️", "😂", "🎉", "😮"].map((unicode) => [
    comparisonKey(unicode),
    unicode,
  ]),
);
export const canonicalEmoji = (unicode: string) =>
  canonicalVariants.get(comparisonKey(unicode)) ?? unicode;
const accepted = z
  .array(
    z.object({
      unicode: z.string(),
      group: z.number().optional(),
      skins: z.array(z.object({ unicode: z.string() })).optional(),
    }),
  )
  .parse(data)
  .filter((entry) => entry.group !== undefined && entry.group !== 2)
  .flatMap((entry) => [
    entry.unicode,
    ...(entry.skins ?? []).map((skin) => skin.unicode),
  ])
  .map(canonicalEmoji);
const emojiByUnicode = new Set(accepted);
const emojiByComparison = new Map(
  accepted.map((unicode) => [comparisonKey(unicode), unicode]),
);
export const emojiSchema = z
  .string()
  .max(64)
  .transform((value) => emojiByComparison.get(comparisonKey(value)) ?? value)
  .refine((value) => emojiByUnicode.has(value), "请选择有效的表情符号。");
