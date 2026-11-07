import { defineConfig } from "@playwright/test";

export default defineConfig({
  timeout: 180000,
  reporter: "list",
  use: { trace: "retain-on-failure" },
  outputDir: ".runtime/test-results/playwright",
  projects: [
    {
      name: "desktop-setup",
      testDir: "./tests/setup",
      testMatch: "electron.setup.ts",
    },
    // Real Electron, worker and daemon share OS resources, so they run one at a time.
    {
      name: "desktop",
      testDir: "./tests/e2e",
      workers: 1,
      dependencies: ["desktop-setup"],
    },
    // Built renderer behind a fake bridge; isolated pages run in parallel, capped
    // so in-process workers and screenshots do not starve each other.
    {
      name: "renderer",
      testDir: "./tests/renderer",
      timeout: 120000,
      workers: "50%",
    },
  ],
});
