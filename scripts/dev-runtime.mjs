import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNode } from "./dev-process.mjs";

/** Bundle current sources so doctor compares with source rather than stale dist. */
export async function maintainRuntime(root, action, signal) {
  signal?.throwIfAborted();
  // The preflight must not overwrite dist while an old system still uses it.
  const directory = await mkdtemp(join(tmpdir(), "aster-maintenance-"));
  try {
    const outfile = join(directory, "maintenance.mjs");
    await build({
      entryPoints: [
        join(root, "src", "desktop", "worker", "worker-maintenance-cli.ts"),
      ],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
    });
    return await runNode(root, [outfile, action, root], signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
