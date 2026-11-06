import { z } from "zod";

const coordinates = {
  x: z.number().int().min(0).max(1023),
  y: z.number().int().min(0).max(639),
};
export const keyActionSchema = z
  .object({
    type: z.literal("key"),
    keys: z
      .array(
        z
          .string()
          .regex(
            /^(?:[a-zA-Z0-9]|F(?:[1-9]|1[0-2])|Return|Tab|Escape|BackSpace|Delete|Insert|Home|End|Prior|Next|Left|Right|Up|Down|space|Control_L|Alt_L|Shift_L|Super_L)$/,
          ),
      )
      .min(1)
      .max(4)
      .refine((keys) => new Set(keys).size === keys.length),
  })
  .strict();
export const typeActionSchema = z
  .object({
    type: z.literal("type"),
    text: z
      .string()
      .min(1)
      .max(1000)
      .refine((text) => !/[\u0000-\u0008\u000b-\u001f]/.test(text)),
  })
  .strict();
export const desktopActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("screenshot") }).strict(),
  z.object({ type: z.literal("move"), ...coordinates }).strict(),
  z
    .object({
      type: z.literal("click"),
      ...coordinates,
      button: z.enum(["left", "middle", "right"]),
      count: z.number().int().min(1).max(2),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      ...coordinates,
      direction: z.enum(["up", "down", "left", "right"]),
      steps: z.number().int().min(1).max(20),
    })
    .strict(),
  keyActionSchema,
  typeActionSchema,
]);
export type DesktopAction = z.infer<typeof desktopActionSchema>;
