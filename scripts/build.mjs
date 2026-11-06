import { build as bundle } from "esbuild";
import { mkdir, copyFile, cp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./project-env.mjs";
import { buildIcons } from "./build-icons.mjs";
import { buildCli } from "./build-cli.mjs";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
loadProjectEnv(fileURLToPath(new URL("..", import.meta.url)));
async function build(options) {
  const result = await bundle({
    ...options,
    metafile: true,
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "");
    if (
      options.entryPoints.includes("src/desktop/preload.ts") &&
      normalized !== "src/desktop/preload.ts" &&
      normalized !== "src/shared/ipc-contracts.ts" &&
      normalized !== "electron"
    )
      throw new Error(
        `Sandbox preload imported an unexpected runtime dependency: ${input}`,
      );
    if (/^(?:\.analysis|\.data|\.runtime|tests)\//.test(normalized))
      throw new Error(
        `Production bundle imported non-production input: ${input}`,
      );
  }
}
function buildRenderer(entry, outfile) {
  return build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "chrome140",
    loader: { ".css": "css", ".woff2": "file" },
    plugins: [
      {
        name: "settings-heroui-css",
        setup(builder) {
          builder.onLoad({ filter: /[/\\]heroui\.css$/ }, async ({ path }) => {
            const result = await postcss([tailwindcss()]).process(
              await readFile(path, "utf8"),
              { from: path },
            );
            return { contents: result.css, loader: "css" };
          });
        },
      },
    ],
  });
}
await rm("dist/renderer", { recursive: true, force: true });
await mkdir("dist/renderer", { recursive: true });
await rm("dist/computer", { recursive: true, force: true });
await writeFile("dist/package.json", '{ "type": "module" }\n');
await buildIcons();
await buildCli();
await copyFile(
  "packages/cli/dist/licenses/THIRD_PARTY_LICENSES.txt",
  "dist/renderer/THIRD_PARTY_LICENSES.txt",
);
await Promise.all([
  build({
    entryPoints: ["src/sandbox/worker.ts"],
    outfile: "dist/sandbox/worker.js",
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["microsandbox", "microsandbox/native", "proxy-chain"],
    target: "node22",
  }),
  build({
    entryPoints: ["scripts/model-auth.ts"],
    outfile: "dist/scripts/model-auth.js",
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"],
    target: "node22",
  }),
  build({
    entryPoints: ["src/worker/supervisor-main.ts"],
    outfile: "dist/worker/supervisor-main.js",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
  }),
  build({
    entryPoints: ["src/ui/features/files/diagram-frame.ts"],
    outfile: "dist/renderer/diagram-frame.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    minify: true,
    target: "chrome140",
  }),
  ,
  build({
    entryPoints: ["src/documents/office-worker.ts"],
    outfile: "dist/documents/office-worker.js",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["mammoth", "xlsx", "sharp", "yauzl", "parse5"],
  }),
  build({
    entryPoints: ["src/documents/pdf-worker.ts"],
    outfile: "dist/documents/pdf-worker.js",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: [
      "pdfjs-dist/legacy/build/pdf.mjs",
      "@napi-rs/canvas",
      "tesseract.js",
    ],
  }),
  build({
    entryPoints: ["src/desktop/launcher.ts"],
    outfile: "dist/desktop/launcher.js",
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["electron"],
    target: "node22",
  }),
  build({
    entryPoints: ["src/desktop/main.ts"],
    outfile: "dist/desktop/main.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "electron-updater"],
    target: "node22",
  }),
  build({
    entryPoints: ["src/desktop/preload.ts"],
    outfile: "dist/desktop/preload.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    target: "node22",
  }),
  build({
    entryPoints: ["src/tools/mcp-server.ts"],
    outfile: "dist/tools/mcp-server.js",
    bundle: true,
    platform: "node",
    format: "esm",
    external: [
      "@modelcontextprotocol/server",
      "@modelcontextprotocol/server/stdio",
    ],
    target: "node22",
  }),
  build({
    entryPoints: ["src/worker/main.ts"],
    outfile: "dist/worker/main.js",
    bundle: true,
    platform: "node",
    format: "esm",
    external: [
      "sharp",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@modelcontextprotocol/client",
      "@modelcontextprotocol/client/stdio",
      "yaml",
      "yauzl",
    ],
    target: "node22",
  }),
  buildRenderer("src/ui/main.tsx", "dist/renderer/app.js"),
  buildRenderer("src/ui/routine-main.tsx", "dist/renderer/routines.js"),
]);
await copyFile("src/desktop/entry.cjs", "dist/desktop/entry.cjs");
await copyFile(
  "src/platform/safe-storage-host.cjs",
  "dist/desktop/safe-storage-host.cjs",
);
await mkdir("dist/platform", { recursive: true });
await copyFile(
  "src/platform/safe-storage-host.cjs",
  "dist/platform/safe-storage-host.cjs",
);
await writeFile(
  "dist/renderer/index.html",
  (await readFile("src/ui/index.html", "utf8")).replace(
    'src="./main.tsx"',
    'src="./app.js"',
  ),
);
await writeFile(
  "dist/renderer/routines.html",
  (await readFile("src/ui/routines.html", "utf8")).replace(
    'src="./routine-main.tsx"',
    'src="./routines.js"',
  ),
);
// Opaque file frames cannot load local script URLs. Bind the bundled script by
// hash instead of granting same-origin access or inline-script permission.
const diagramScript = (
  await readFile("dist/renderer/diagram-frame.js", "utf8")
).replace(/<\/script/gi, "<\\/script");
const diagramHash = createHash("sha256").update(diagramScript).digest("base64");
await writeFile(
  "dist/renderer/diagram-frame.html",
  (await readFile("src/ui/features/files/diagram-frame.html", "utf8"))
    .replace("DIAGRAM_SCRIPT_HASH", diagramHash)
    .replace(
      /<script>\s*DIAGRAM_SCRIPT_CONTENT;?\s*<\/script>/,
      () => `<script>${diagramScript}</script>`,
    ),
);
await cp("node_modules/katex/dist/fonts", "dist/renderer/fonts", {
  recursive: true,
});
await copyFile(
  "node_modules/katex/dist/katex.min.css",
  "dist/renderer/katex.min.css",
);
await copyFile("node_modules/katex/LICENSE", "dist/renderer/katex-LICENSE");
await copyFile("node_modules/mermaid/LICENSE", "dist/renderer/mermaid-LICENSE");
await copyFile(
  "node_modules/pdfjs-dist/build/pdf.worker.mjs",
  "dist/renderer/pdf.worker.mjs",
);
for (const folder of ["cmaps", "standard_fonts", "wasm"])
  await cp(`node_modules/pdfjs-dist/${folder}`, `dist/renderer/pdf/${folder}`, {
    recursive: true,
  });
await copyFile("node_modules/pdfjs-dist/LICENSE", "dist/renderer/pdf/LICENSE");
await mkdir("dist/documents/tessdata", { recursive: true });
for (const [pkg, file] of [
  ["eng", "eng.traineddata.gz"],
  ["chi_sim", "chi_sim.traineddata.gz"],
])
  await copyFile(
    `node_modules/@tesseract.js-data/${pkg}/4.0.0_best_int/${file}`,
    `dist/documents/tessdata/${file}`,
  );
