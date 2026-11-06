import { z } from "zod";

export const approvalDecisionSchema = z.enum(["ask", "allow", "deny"]);
export const conditionRuleSchema = z
  .object({
    id: z.uuid(),
    condition: z.string().trim().min(1).max(1000),
    decision: approvalDecisionSchema,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export const reviewViewSchema = z
  .object({
    state: z.enum(["reviewing", "decided", "abandoned", "manual"]),
    decision: approvalDecisionSchema.nullable(),
    reason: z.string().max(600),
    reviewer: z.literal("jev").optional(),
    confidence: z.number().min(0).max(1).optional(),
    rules: z
      .array(
        z
          .object({ condition: z.string(), decision: approvalDecisionSchema })
          .strict(),
      )
      .max(32),
  })
  .strict();

export type ScriptApprovalDecision = {
  decision: "allow" | "ask";
  reason: string;
  confidence?: number;
};
