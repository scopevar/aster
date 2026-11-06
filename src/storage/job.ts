import { z } from "zod";
import { attachmentSchema } from "../shared/files/attachments.js";
export const jobSchema = z.object({
  id: z.string(),
  botId: z.string(),
  conversationId: z.string(),
  text: z.string(),
  threadId: z.string().nullable(),
  description: z.string(),
  attachments: z.array(attachmentSchema),
  groupOrdinal: z.number().int().optional(),
});
export type Job = z.infer<typeof jobSchema>;
