import { z } from "zod";
import { commandSchema, envelopeSchema } from "../commands.js";

/** Renderer directory grants carry an opaque Main-issued credential, never a path. */
export const directoryCredentialCommandSchema = z
  .object({
    type: z.literal("directory.attach"),
    conversationId: z.uuid(),
    credential: z.uuid(),
  })
  .strict();
const ordinaryCommandSchema = commandSchema.transform((command, ctx) => {
  if (command.type === "directory.attach") {
    ctx.addIssue({ code: "custom", message: "目录授权必须使用原生选择凭据。" });
    return z.NEVER;
  }
  return command;
});
export const desktopCommandSchema = z.union([
  ordinaryCommandSchema,
  directoryCredentialCommandSchema,
]);
export type DesktopCommand = z.infer<typeof desktopCommandSchema>;
export const desktopEnvelopeSchema = envelopeSchema
  .pick({ id: true })
  .extend({ command: desktopCommandSchema })
  .strict();
export type DesktopEnvelope = z.infer<typeof desktopEnvelopeSchema>;

/** Discard obsolete cache metadata while preserving command identity; IPC remains strict. */
export const storedDesktopEnvelopeSchema = desktopEnvelopeSchema.strip();
