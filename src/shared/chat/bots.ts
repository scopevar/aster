import { z } from "zod";
import { idSchema } from "../core.js";
import { avatarSchema } from "../avatar.js";

export const botSchema = z.object({
  lifecycle: z.enum(["active", "deleting", "deleted"]),
  id: idSchema,
  name: z.string(),
  description: z.string(),
  createdAt: z.number(),
  tags: z.string(),
  language: z.enum(["auto", "zh-CN", "en", "ja"]),
  avatar: avatarSchema,
});
export type Bot = z.infer<typeof botSchema>;
