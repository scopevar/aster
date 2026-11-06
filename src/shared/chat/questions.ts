import { z } from "zod";

export const questionInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(500),
    options: z
      .array(z.string().trim().min(1).max(160))
      .min(2)
      .max(6)
      .refine(
        (values) => new Set(values).size === values.length,
        "选项不能重复",
      ),
  })
  .strict();
export type QuestionInput = z.infer<typeof questionInputSchema>;
export const questionSchema = questionInputSchema.extend({
  id: z.uuid(),
  messageId: z.uuid(),
  botId: z.uuid(),
  conversationId: z.uuid(),
  runId: z.uuid(),
  status: z.enum(["pending", "answered", "skipped", "cancelled"]),
  answer: z.string().nullable(),
  answerRunId: z.uuid().nullable(),
});
export type Question = z.infer<typeof questionSchema>;
export const questionAnswerSchema = z
  .object({
    type: z.literal("question.answer"),
    id: z.uuid(),
    conversationId: z.uuid(),
    answer: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("option"),
          index: z.number().int().min(0).max(5),
        })
        .strict(),
      z
        .object({
          type: z.literal("custom"),
          text: z.string().trim().min(1).max(4000),
        })
        .strict(),
      z.object({ type: z.literal("skip") }).strict(),
    ]),
  })
  .strict();
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export const questionRequestSchema = z
  .object({
    callId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9_:-]+$/),
    question: questionInputSchema,
  })
  .strict();
export function questionText(question: Question) {
  const status = {
    pending: "待回答",
    answered: "已回答",
    skipped: "已忽略",
    cancelled: "已取消",
  }[question.status];
  return `${question.prompt}\n${question.options.map((label, index) => `${String.fromCharCode(65 + index)}. ${label}`).join("\n")}\n状态：${status}${question.answer === null ? "" : `\n用户回答：${question.answer}`}`;
}
