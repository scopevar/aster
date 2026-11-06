import { z } from "zod";

export const idSchema = z.uuid();
export const resultSchema = z.object({
  id: idSchema.optional(),
  conversationId: idSchema.optional(),
  revision: z.number().int().nonnegative().optional(),
});
export type CommandResult = z.infer<typeof resultSchema>;
export const failureSchema = z.object({
  code: z.enum([
    "invalid_input",
    "not_found",
    "conflict",
    "capacity",
    "unavailable",
    "unauthorized",
    "forbidden",
    "attachment_pending",
    "quota_exceeded",
    "internal",
    "unknown",
  ]),
  message: z.string(),
});
export type Failure = z.infer<typeof failureSchema>;
export class AppError extends Error {
  constructor(
    readonly code: Failure["code"],
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
