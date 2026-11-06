import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, isBuiltin } from "node:module";
import { loadProjectEnv } from "./project-env.mjs";
import { collectLicenses } from "./collect-licenses.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = join(root, "packages/cli");
const output = join(packageDirectory, "dist");
const manifest = JSON.parse(
  await readFile(join(packageDirectory, "package.json"), "utf8"),
);
const dependencies = Object.keys(manifest.dependencies);
loadProjectEnv(root);

export async function buildCli() {
  // Only generated package output is replaced; no user data or installed daemon is touched.
  await rm(output, { recursive: true, force: true });
  const entries = [
    ["packages/cli/src/main.ts", "cli/main.js"],
    ["src/tools/mcp-server.ts", "tools/mcp-server.js"],
    ["src/sandbox/worker.ts", "sandbox/worker.js"],
    ["src/documents/office-worker.ts", "documents/office-worker.js"],
    ["scripts/model-auth.ts", "scripts/model-auth.js"],
  ];
  const inputs = new Set();
  for (const [entry, destination] of entries) {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      ...(destination === "cli/main.js"
        ? {
            outdir: output,
            entryNames: "cli/main",
            chunkNames: "cli/[name]-[hash]",
            splitting: true,
          }
        : { outfile: join(output, destination) }),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: dependencies,
      metafile: true,
      banner: {
        js: 'import { createRequire as __asterRequire } from "node:module"; const require = __asterRequire(import.meta.url);',
      },
    });
    for (const input of Object.keys(result.metafile.inputs)) {
      const path = input.replaceAll("\\", "/");
      if (/^(?:src\/(?:desktop|ui)\/|tests\/|\.runtime\/)/.test(path))
        throw new Error(
          `CLI imported a desktop or development module: ${input}`,
        );
      inputs.add(path);
    }
    for (const file of Object.values(result.metafile.outputs))
      for (const imported of file.imports)
        if (
          imported.external &&
          !isBuiltin(imported.path) &&
          !dependencies.some(
            (name) =>
              imported.path === name || imported.path.startsWith(`${name}/`),
          )
        )
          throw new Error(
            `CLI runtime dependency is undeclared: ${imported.path}`,
          );
  }
  await mkdir(join(output, "platform"), { recursive: true });
  await cp(
    join(root, "src/platform/safe-storage-host.cjs"),
    join(output, "platform/safe-storage-host.cjs"),
  );
  const xlsxDirectory = dirname(createRequire(import.meta.url).resolve("xlsx"));
  await mkdir(join(output, "licenses"), { recursive: true });
  await cp(join(root, "LICENSE"), join(output, "licenses", "LICENSE.txt"));
  await writeFile(
    join(output, "licenses", "THIRD_PARTY_LICENSES.txt"),
    await collectLicenses(root, join(output, "licenses", "third-party")),
  );
  for (const [source, name] of [
    ["LICENSE", "xlsx-LICENSE"],
    ["dist/LICENSE", "xlsx-codepage-LICENSE"],
  ])
    await cp(join(xlsxDirectory, source), join(output, "licenses", name));
  await writeFile(
    join(output, "build-inputs.json"),
    JSON.stringify([...inputs].sort(), null, 2) + "\n",
  );
  await chmod(join(output, "cli/main.js"), 0o755);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildCli();
