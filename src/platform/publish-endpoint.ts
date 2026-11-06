import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Caller owns the directory lease. Readers see a whole record or the previous record. */
export async function publishEndpoint(
  directory: string,
  value: unknown,
  name: "endpoint.json" | "supervisor.json" = "endpoint.json",
) {
  const staging = join(directory, `${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(staging, JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
    // Windows readers/scanners may temporarily deny replacement of an open file.
    // Retry only that atomic operation, never unlink the last usable record.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(staging, join(directory, name));
        return;
      } catch (error) {
        if (
          process.platform !== "win32" ||
          attempt >= 6 ||
          !(
            error instanceof Error &&
            "code" in error &&
            (error.code === "EPERM" ||
              error.code === "EACCES" ||
              error.code === "EBUSY")
          )
        )
          throw error;
        await delay(20 * 2 ** attempt);
      }
    }
  } finally {
    await rm(staging, { force: true });
  }
}
