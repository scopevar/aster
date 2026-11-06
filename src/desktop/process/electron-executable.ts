import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Resolve metadata without evaluating electron/index.js, which can download binaries. */
export async function electronExecutable(root: string): Promise<string> {
  const directory = dirname(
    createRequire(join(root, "package.json")).resolve("electron"),
  );
  const relative = (await readFile(join(directory, "path.txt"), "utf8")).trim();
  if (!relative) throw new Error("Electron 程序路径记录为空。");
  const binary = join(
    process.env.ELECTRON_OVERRIDE_DIST_PATH || join(directory, "dist"),
    relative,
  );
  await access(
    binary,
    process.platform === "win32" ? constants.F_OK : constants.X_OK,
  );
  return binary;
}
