import { z } from "zod";
import { canonicalEmoji } from "../shared/emoji.js";
import data from "emojibase-data/zh/compact.json" with { type: "json" };
import messages from "emojibase-data/zh/messages.json" with { type: "json" };

const entrySchema = z.object({
  unicode: z.string(),
  label: z.string(),
  group: z.number().optional(),
  order: z.number().optional(),
  tags: z.array(z.string()).optional(),
});
const dataset = z
  .array(entrySchema.extend({ skins: z.array(entrySchema).optional() }))
  .parse(data);
export const quickEmojis = ["👍", "👎", "❤️", "😂", "🎉", "😮"];
export const emojiGroups = z
  .object({
    groups: z.array(z.object({ order: z.number(), message: z.string() })),
  })
  .parse(messages).groups;
export const emojiCatalog = dataset
  .filter((e) => e.group !== undefined && e.group !== 2)
  .flatMap((e) => [
    e,
    ...(e.skins ?? []).map((s) => ({ ...s, group: e.group, tags: e.tags })),
  ])
  .map((e) => ({
    ...e,
    unicode: canonicalEmoji(e.unicode),
  }))
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
export const emojiByUnicode = new Map(emojiCatalog.map((e) => [e.unicode, e]));
