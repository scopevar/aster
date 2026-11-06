import { z } from "zod";
import { updateChannelSchema } from "./app-update.js";
import { shortcutSchema, shortcutStatusSchema } from "./shortcut.js";

export const defaultTimeZone = "Asia/Shanghai";

export const timeZoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    if (value === "auto") return true;
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "时区无效。");
export const themeSchema = z.enum(["system", "light", "dark"]);
export const legacyPreferencesSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    hardwareAcceleration: z.boolean(),
    timeZone: timeZoneSchema,
  })
  .strict();
export const preferencesV2Schema = legacyPreferencesSchema.extend({
  version: z.literal(2),
  theme: themeSchema,
});
export const preferencesSchema = preferencesV2Schema.extend({
  version: z.literal(3),
  shortcut: shortcutSchema.nullable(),
  updateChannel: updateChannelSchema.optional(),
  autoUpdate: z.boolean().optional(),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const desktopPreferencesSchema = preferencesSchema.extend({
  appliedHardwareAcceleration: z.boolean(),
  shortcutStatus: shortcutStatusSchema,
});
export type DesktopPreferences = z.infer<typeof desktopPreferencesSchema>;
export const preferencesChangeSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    hardwareAcceleration: z.boolean().optional(),
    timeZone: timeZoneSchema.optional(),
    theme: themeSchema.optional(),
    shortcut: shortcutSchema.nullable().optional(),
    updateChannel: updateChannelSchema.optional(),
    autoUpdate: z.boolean().optional(),
  })
  .strict();
export type PreferencesChange = z.infer<typeof preferencesChangeSchema>;
