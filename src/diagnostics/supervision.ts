import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  supervisionStateSchema,
  type SupervisionDiagnostics,
} from "../shared/supervision.js";

const schema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    pid: z.number().int().positive(),
    workerPid: z.number().int().positive().nullable(),
    state: supervisionStateSchema,
    restarts: z.number().int().nonnegative(),
    detail: z.string().max(1000),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
/** A bounded local heartbeat projection; never export raw details, paths, identity or tokens. */
export async function readSupervisionDiagnostics(
  directory: string,
  signal: AbortSignal,
): Promise<SupervisionDiagnostics> {
  try {
    signal.throwIfAborted();
    const file = await open(join(directory, "supervisor.json"), "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8192)
        return { available: false, reason: "invalid_record" };
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      signal.throwIfAborted();
      if (bytesRead > 8192)
        return { available: false, reason: "invalid_record" };
      const value = schema.parse(
        JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
      );
      const age = Date.now() - value.updatedAt;
      return {
        available: true,
        state: value.state,
        restarts: value.restarts,
        updatedAt: value.updatedAt,
        stale:
          value.state !== "stopped" &&
          value.state !== "failed" &&
          (age > 30000 || age < -5000),
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    signal.throwIfAborted();
    return {
      available: false,
      reason:
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "not_enabled"
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? "invalid_record"
            : "unreadable",
    };
  }
}
