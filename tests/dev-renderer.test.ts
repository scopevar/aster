import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import config from "../electron.vite.config.js";

await test("parallel development renderers serve their own worktrees on distinct ports", async () => {
  // Exercise the actual renderer configuration and Vite listeners, including
  // the resolved port electron-vite passes to ELECTRON_RENDERER_URL.
  const root = await mkdtemp(join(tmpdir(), "aster-dev-renderer-"));
  const servers: ViteDevServer[] = [];
  const urls: string[] = [];
  try {
    assert.ok(config.renderer);
    for (const name of ["task-a", "task-b"]) {
      const directory = join(root, name);
      await mkdir(directory);
      await writeFile(
        join(directory, "index.html"),
        `<!doctype html><html><head></head><body>${name}</body></html>`,
      );
      await writeFile(
        join(directory, "routines.html"),
        `<!doctype html><html><head><link rel="stylesheet" href="./routines.css" /></head><body>${name}-routines</body></html>`,
      );
      const server = await createServer({
        ...config.renderer,
        configFile: false,
        envFile: false,
        root: directory,
        publicDir: false,
        cacheDir: join(directory, ".vite"),
        logLevel: "silent",
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { ...config.renderer.server, watch: null },
      });
      servers.push(server);
      await server.listen();
      const address = server.httpServer?.address();
      assert.ok(address && typeof address !== "string");
      assert.equal(server.config.server.port, address.port);
      const url = `http://127.0.0.1:${address.port}/`;
      urls.push(url);
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.match(await response.text(), new RegExp(`<body>${name}</body>`));
      const routineResponse = await fetch(new URL("routines.html", url));
      assert.equal(routineResponse.status, 200);
      const routineHtml = await routineResponse.text();
      assert.match(routineHtml, new RegExp(`<body>${name}-routines</body>`));
      assert.doesNotMatch(routineHtml, /href="\.\/routines\.css"/);
    }
    assert.equal(new Set(urls).size, 2);
    const firstUrl = urls[0];
    assert.ok(firstUrl);
    assert.match(await (await fetch(firstUrl)).text(), /<body>task-a<\/body>/);
  } finally {
    await Promise.all(servers.map((server) => server.close()));
    await rm(root, { recursive: true, force: true });
  }
});
