import { z } from "zod";
export const avatarShapes = z.enum([
  "blob",
  "pebble",
  "square",
  "pill",
  "wedge",
  "hexagon",
  "cloud",
  "drop",
]);
export const avatarColors = z.enum([
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "gray",
]);
export const avatarSchema = z.object({
  shape: avatarShapes,
  color: avatarColors,
  revision: z.number().int().nonnegative(),
  imageHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type AvatarStyle = z.infer<typeof avatarSchema>;
export const defaultAvatar: AvatarStyle = {
  shape: "hexagon",
  color: "cyan",
  revision: 0,
  imageHash: null,
};
/** The default style is rendered using the bundled application icon. */
export function isDefaultAvatar(appearance: AvatarStyle): boolean {
  return (
    appearance.imageHash === null &&
    appearance.shape === defaultAvatar.shape &&
    appearance.color === defaultAvatar.color
  );
}
export const maxAvatarBytes = 64 * 1024;
export const avatarBase64 = z
  .string()
  .min(1)
  .max(Math.ceil(maxAvatarBytes / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const avatarAccessSchema = z
  .object({ botId: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type AvatarAccess = z.infer<typeof avatarAccessSchema>;
export const avatarContentSchema = avatarAccessSchema.extend({
  data: avatarBase64,
});
export type AvatarContent = z.infer<typeof avatarContentSchema>;
