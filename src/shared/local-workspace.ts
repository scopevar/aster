import { z } from "zod";

export const localWorkspaceRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z
    .object({
      action: z.literal("select"),
      source: z.string().max(200).nullable(),
    })
    .strict(),
]);
export const localWorkspaceStatusSchema = z
  .object({
    ready: z.boolean(),
    directory: z.string(),
    sources: z.array(
      z
        .object({ id: z.string(), label: z.string(), directory: z.string() })
        .strict(),
    ),
    backup: z.string().nullable(),
  })
  .strict();
export type LocalWorkspaceRequest = z.infer<typeof localWorkspaceRequestSchema>;
export type LocalWorkspaceStatus = z.infer<typeof localWorkspaceStatusSchema>;
