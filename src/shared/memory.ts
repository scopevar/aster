import { z } from "zod";

export const memoryScopeSchema = z
  .object({ botId: z.uuid(), conversationId: z.uuid().nullable() })
  .strict();
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export const memorySaveSchema = z
  .object({
    type: z.literal("memory.save"),
    scope: memoryScopeSchema,
    id: z.uuid(),
    revision: z.number().int().nonnegative(),
    topic: z.string().trim().min(1).max(100),
    content: z.string().trim().min(1).max(800),
  })
  .strict();
export const memoryForgetSchema = z
  .object({
    type: z.literal("memory.forget"),
    scope: memoryScopeSchema,
    id: z.uuid(),
    revision: z.number().int().positive(),
  })
  .strict();
export const memoryAutoSchema = z
  .object({
    type: z.literal("memory.auto"),
    scope: memoryScopeSchema,
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
  })
  .strict();
export const memoryJobActionSchema = z
  .object({
    type: z.literal("memory.job"),
    scope: memoryScopeSchema,
    id: z.uuid(),
    action: z.enum(["cancel", "retry"]),
  })
  .strict();
export const memoryEntrySchema = z.object({
  id: z.uuid(),
  topic: z.string(),
  content: z.string(),
  revision: z.number().int().positive(),
  origin: z.enum(["manual", "automatic"]),
  sourceMessageId: z.uuid().nullable(),
  sourceQuote: z.string().nullable(),
  updatedAt: z.number(),
});
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export const memoryJobStatusSchema = z.enum([
  "queued",
  "proposing",
  "verifying",
  "cancelling",
  "completed",
  "conflict",
  "failed",
  "cancelled",
]);
export type MemoryJobStatus = z.infer<typeof memoryJobStatusSchema>;
export const memoryViewSchema = z.object({
  scope: memoryScopeSchema,
  revision: z.number().int().nonnegative(),
  automatic: z.boolean(),
  entries: z.array(memoryEntrySchema).max(200),
  jobs: z
    .array(
      z.object({
        id: z.uuid(),
        status: memoryJobStatusSchema,
        error: z.string().nullable(),
        createdAt: z.number(),
        sourceMessageId: z.uuid(),
      }),
    )
    .max(30),
});
export type MemoryView = z.infer<typeof memoryViewSchema>;
export const memoryProposalSchema = z
  .object({
    conflicts: z.array(z.string().min(1).max(400)).max(10),
    changes: z
      .array(
        z
          .object({
            id: z.uuid().nullable(),
            revision: z.number().int().nonnegative(),
            topic: z.string().trim().min(1).max(100),
            content: z.string().trim().min(1).max(800),
            quote: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type MemoryProposal = z.infer<typeof memoryProposalSchema>;
export interface MemoryWork {
  id: string;
  scope: MemoryScope;
  revision: number;
  sourceMessageId: string;
  text: string;
  entries: MemoryEntry[];
  forgottenTopics: string[];
}
export interface StructuredModel {
  capture?(botId?: string): StructuredModel;
  generate(input: {
    text: string;
    instructions: string;
    schema: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<unknown>;
}
/** The only project id injected into model context until a workspace chooser exists. */
export const localProjectId = "local";
export const sharedMemoryScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account") }).strict(),
  z
    .object({
      kind: z.literal("project"),
      projectId: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    })
    .strict(),
]);
export type SharedMemoryScope = z.infer<typeof sharedMemoryScopeSchema>;
export const sharedMemorySaveSchema = z
  .object({
    type: z.literal("memory.shared.save"),
    scope: sharedMemoryScopeSchema,
    id: z.uuid(),
    revision: z.number().int().nonnegative(),
    topic: z.string().trim().min(1).max(100),
    content: z.string().trim().min(1).max(800),
  })
  .strict();
export const sharedMemoryForgetSchema = z
  .object({
    type: z.literal("memory.shared.forget"),
    scope: sharedMemoryScopeSchema,
    id: z.uuid(),
    revision: z.number().int().positive(),
  })
  .strict();
export const sharedMemoryEntrySchema = z
  .object({
    id: z.uuid(),
    topic: z.string(),
    content: z.string(),
    revision: z.number().int().positive(),
    updatedAt: z.number(),
  })
  .strict();
export type SharedMemoryEntry = z.infer<typeof sharedMemoryEntrySchema>;
export const sharedMemoryViewSchema = z
  .object({
    scope: sharedMemoryScopeSchema,
    revision: z.number().int().nonnegative(),
    entries: z.array(sharedMemoryEntrySchema).max(200),
  })
  .strict();
export type SharedMemoryView = z.infer<typeof sharedMemoryViewSchema>;
