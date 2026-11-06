import {
  test as base,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { daemonStatus, stopDaemon } from "../../src/daemon/lifecycle.js";

type LaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>;
type Desktop = {
  directory: string;
  launch(options?: LaunchOptions): Promise<ElectronApplication>;
  stop(): Promise<void>;
};

/** Owns only this test's data, controller and independent daemon, including failed tests. */
export const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({}, use) => {
    // Keep SQLite's Windows staging paths short; report names remain descriptive.
    const root = resolve(".runtime/test-results");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "desktop-"));
    let app: ElectronApplication | undefined;
    const stop = async () => {
      try {
        if (await daemonStatus(directory)) await stopDaemon(directory);
      } finally {
        const current = app;
        app = undefined;
        await current?.close();
      }
    };
    try {
      await use({
        directory,
        async launch(options = {}) {
          if (app)
            throw Error("Stop the current desktop before launching another");
          const env = Object.fromEntries(
            Object.entries({ ...process.env, ...options.env }).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          );
          env.ASTER_DATA_DIR = directory;
          env.ASTER_DISABLE_AUTO_UPDATE =
            options.env?.ASTER_DISABLE_AUTO_UPDATE ?? "1";
          delete env.ELECTRON_RUN_AS_NODE;
          delete env.ELECTRON_RENDERER_URL;
          app = await electron.launch({
            args: [resolve(".")],
            chromiumSandbox: true,
            ...options,
            env,
          });
          return app;
        },
        stop,
      });
    } finally {
      await stop();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 15,
        retryDelay: 200,
      });
    }
  },
});

export { expect } from "@playwright/test";
