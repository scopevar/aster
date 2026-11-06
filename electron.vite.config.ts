import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)));

const rendererDevelopmentPlugin: Plugin = {
  name: "aster-renderer-development-entry",
  transformIndexHtml: {
    order: "pre",
    handler(html, context) {
      const transformed = html.replace(
        /\s*<link rel="stylesheet" href="\.\/(?:app|routines)\.css" \/>/,
        "",
      );
      return context.server
        ? transformed.replace(
            "connect-src 'self';",
            "connect-src 'self' ws://127.0.0.1:*;",
          )
        : transformed;
    },
  },
};

export default defineConfig({
  main: {
    build: {
      outDir: resolve(projectRoot, "dist/desktop"),
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(projectRoot, "src/desktop/main.ts"),
        output: {
          entryFileNames: "main.cjs",
          format: "cjs",
        },
      },
    },
  },
  preload: {
    build: {
      outDir: resolve(projectRoot, "dist/desktop"),
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(projectRoot, "src/desktop/preload.ts"),
        output: {
          entryFileNames: "preload.cjs",
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    root: join(projectRoot, "src/ui"),
    publicDir: resolve(projectRoot, "dist/renderer"),
    plugins: [react(), rendererDevelopmentPlugin],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: false,
    },
    build: {
      outDir: resolve(projectRoot, "dist/renderer-vite"),
      rollupOptions: {
        input: {
          index: resolve(projectRoot, "src/ui/index.html"),
          routines: resolve(projectRoot, "src/ui/routines.html"),
        },
      },
    },
  },
});
