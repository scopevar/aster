import { access, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export function stopMarker(directory: string, id: string) {
  return join(directory, `worker-stop-${z.uuid().parse(id)}.json`);
}
/** The authenticated stop request records intent before acknowledging or draining. */
export async function requestSupervisedStop(directory: string, id: string) {
  let file;
  try {
    file = await open(stopMarker(directory, id), "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      return;
    throw error;
  }
  try {
    await file.writeFile(
      JSON.stringify({ version: 1, id, stoppedAt: Date.now() }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function stopWasRequested(directory: string, id: string) {
  try {
    await access(stopMarker(directory, id));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
