import { build } from "esbuild";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function buildRendererFixture(contents: string, outfile: string) {
  // Use the production stylesheet, including its fonts and Tailwind processing.
  const stylesheet = resolve("dist/renderer/app.css");
  await access(stylesheet);
  await build({
    stdin: { contents, resolveDir: resolve("."), loader: "tsx" },
    outfile,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  return pathToFileURL(stylesheet).href;
}
