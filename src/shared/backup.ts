import { z } from "zod";

/** Success-path schema gate. storage/store.ts rejects anything newer. */
export const maxDatabaseVersion = 42;
export const minDatabaseVersion = 2;

export const backupRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("save") }).strict(),
  z.object({ action: z.literal("schedule") }).strict(),
  z.object({ action: z.literal("schedule-previous") }).strict(),
]);
export type BackupRequest = z.infer<typeof backupRequestSchema>;

export const backupWorkerRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z
    .object({
      action: z.literal("save"),
      path: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      action: z.literal("schedule"),
      path: z.string().min(1).max(4096),
    })
    .strict(),
  z.object({ action: z.literal("schedule-previous") }).strict(),
]);
export type BackupWorkerRequest = z.infer<typeof backupWorkerRequestSchema>;

export const backupStatusSchema = z
  .object({
    pending: z.boolean(),
    pendingLabel: z.string().max(240).nullable(),
    previousAvailable: z.boolean(),
    notice: z.string().max(500),
  })
  .strict();
export type BackupStatus = z.infer<typeof backupStatusSchema>;
