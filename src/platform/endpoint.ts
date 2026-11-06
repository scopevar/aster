import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";

export const endpointSchema = z.object({
  port: z.number().int().min(1024).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int(),
  supervisionId: z.uuid().optional(),
  kind: z.literal("daemon").optional(),
  instanceId: z.uuid().optional(),
  role: z.enum(["execution", "controller"]).optional(),
});
export type Endpoint = z.infer<typeof endpointSchema>;
export function portForDirectory(directory: string) {
  const identity =
    process.platform === "win32"
      ? resolve(directory).toLowerCase()
      : resolve(directory);
  return (
    24000 +
    (createHash("sha256").update(identity).digest().readUInt16BE(0) % 16000)
  );
}
