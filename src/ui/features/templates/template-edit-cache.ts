import { z } from "zod";
import {
  templateDraftSchema,
  templatePayloadSchema,
} from "../../../shared/templates/templates.js";

// Editing can temporarily contain empty fields. Saved templates and files remain strict.
const editingPayload = z
  .object({
    ...templatePayloadSchema.shape,
    name: z.string().max(80),
    description: z.string().max(4000),
    skills: z
      .array(
        z
          .object({
            name: z.string().max(80),
            description: z.string().max(500),
            body: z.string().max(32000),
          })
          .strict(),
      )
      .max(100),
    routines: z
      .array(
        z
          .object({
            name: z.string().max(80),
            prompt: z.string().max(16000),
            schedule: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("webhook") }).strict(),
              z
                .object({
                  kind: z.literal("at"),
                  at: z.iso.datetime({ offset: true }),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("cron"),
                  expression: z.string().max(120),
                  timeZone: z.string().max(100),
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export const templateEditCacheSchema = templateDraftSchema.extend({
  payload: editingPayload,
});
