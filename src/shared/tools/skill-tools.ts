import { z } from "zod";
import { skillSchema, skillSummarySchema } from "./skills.js";

const identity = {
  id: z.uuid(),
  revision: z.number().int().positive(),
};
const content = {
  name: skillSummarySchema.shape.name,
  description: skillSummarySchema.shape.description,
  body: skillSchema.shape.body,
};
/** Ownership is supplied by the active run, never by model arguments. */
export const skillOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("read"), ...identity }).strict(),
  z.object({ action: z.literal("create"), ...content }).strict(),
  z.object({ action: z.literal("update"), ...identity, ...content }).strict(),
  z.object({ action: z.literal("delete"), ...identity }).strict(),
]);
export const skillToolRequestSchema = z
  .object({
    callId: z.string().min(1).max(160),
    operation: skillOperationSchema,
  })
  .strict();
export const skillToolResultSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      skills: z.array(skillSummarySchema).max(100),
    })
    .strict(),
  z.object({ action: z.literal("read"), skill: skillSchema }).strict(),
  z
    .object({
      action: z.enum(["create", "update", "delete"]),
      skill: skillSummarySchema,
      messageId: z.uuid(),
    })
    .strict(),
]);
export type SkillOperation = z.infer<typeof skillOperationSchema>;
export type SkillToolResult = z.infer<typeof skillToolResultSchema>;
