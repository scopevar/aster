import { z } from "zod";
import { desktopActionSchema } from "./computer-actions.js";
import { reviewViewSchema } from "./approval-conditions.js";
import { scriptActionSchema } from "./scripts.js";
// Desktop parameters remain readable in historical messages; new calls only use ScriptAction.
export const agentActionSchema = z.union([
  desktopActionSchema,
  scriptActionSchema,
]);
export type AgentAction = z.infer<typeof agentActionSchema>;
export const toolCallStatusSchema = z.enum([
  "pending",
  "approved",
  "running",
  "cancelling",
  "completed",
  "declined",
  "cancelled",
  "failed",
  "expired",
  "unknown",
]);
export const computerToolSchema = z
  .object({
    id: z.uuid(),
    botId: z.uuid(),
    conversationId: z.uuid(),
    runId: z.uuid(),
    action: agentActionSchema,
    generation: z.number().int().nonnegative(),
    controlRevision: z.number().int().nonnegative(),
    status: toolCallStatusSchema,
    detail: z.string().max(1000),
    expiresAt: z.number().int().positive(),
    hasImage: z.boolean(),
    review: reviewViewSchema.nullable().optional(),
  })
  .strict();
export type ComputerTool = z.infer<typeof computerToolSchema>;
export const toolDecisionSchema = z
  .object({
    type: z.literal("tool.decide"),
    id: z.uuid(),
    conversationId: z.uuid(),
    decision: z.enum(["allow", "decline"]),
  })
  .strict();
export const toolImageAccessSchema = z
  .object({ id: z.uuid(), conversationId: z.uuid() })
  .strict();
export const toolImageSchema = z
  .object({
    mime: z.literal("image/png"),
    data: z
      .string()
      .max(4 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export function actionName(action: AgentAction): string {
  return {
    screenshot: "查看电脑屏幕",
    click: "点击电脑",
    move: "移动鼠标",
    scroll: "滚动电脑",
    key: "按下快捷键",
    type: "输入文字",
    script: "执行隔离脚本",
  }[action.type];
}
