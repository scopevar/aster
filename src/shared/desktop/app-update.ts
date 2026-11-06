import { z } from "zod";

export const updateChannelSchema = z.enum(["latest", "nightly"]);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

export const appUpdateStatusSchema = z.enum([
  "disabled",
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "preparing",
  "installing",
  "up-to-date",
  "error",
]);

const versionSchema = z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/);

export const appUpdateStateSchema = z
  .object({
    enabled: z.boolean(),
    status: appUpdateStatusSchema,
    channel: updateChannelSchema,
    currentVersion: versionSchema,
    availableVersion: versionSchema.nullable(),
    downloadedVersion: versionSchema.nullable(),
    downloadPercent: z.number().int().min(0).max(100).nullable(),
    message: z.string().max(200).nullable(),
    disabledReason: z.string().max(200).nullable(),
  })
  .strict();
export type AppUpdateState = z.infer<typeof appUpdateStateSchema>;

export const appUpdateRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("state") }).strict(),
  z.object({ action: z.literal("check") }).strict(),
  z.object({ action: z.literal("download") }).strict(),
  z.object({ action: z.literal("install") }).strict(),
  z.object({ action: z.literal("cancel-install") }).strict(),
]);
export type AppUpdateRequest = z.infer<typeof appUpdateRequestSchema>;

/** 没有清单、也没有 ASTER_UPDATE_URL 时的原因。设置页据此保留未配置文案。 */
export const UPDATE_FEED_MISSING = "更新源尚未配置。";
