import { z } from "zod";

export const shortcutKeySchema = z
  .string()
  .regex(/^(?:[A-Z0-9]|Space|F(?:[1-9]|1[0-9]|2[0-4]))$/);
export const shortcutSchema = z
  .object({
    control: z.boolean(),
    alt: z.boolean(),
    shift: z.boolean(),
    key: shortcutKeySchema,
  })
  .strict()
  .refine(
    (value) => value.control || value.alt,
    "快捷键至少需要 Ctrl 或 Alt。",
  );
export type Shortcut = z.infer<typeof shortcutSchema>;
export const shortcutStatusSchema = z
  .object({
    state: z.enum(["disabled", "active", "unavailable"]),
    detail: z.string().max(240),
  })
  .strict();
export function shortcutAccelerator(value: Shortcut) {
  return [
    value.control ? "Control" : "",
    value.alt ? "Alt" : "",
    value.shift ? "Shift" : "",
    value.key,
  ]
    .filter(Boolean)
    .join("+");
}
export function shortcutLabel(value: Shortcut | null) {
  return value
    ? shortcutAccelerator(value)
        .replace("Control", "Ctrl")
        .replace("Space", "空格")
    : "未设置";
}
