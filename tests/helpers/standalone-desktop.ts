import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

/** Real executable without Playwright's Main inspector/loader. Its debugger
 * lifetime must not become the owner of detached execution daemons. */
export async function standaloneDesktop(
  env: NodeJS.ProcessEnv,
  installedExecutable?: string,
) {
  const executable: unknown =
    installedExecutable ?? createRequire(import.meta.url)("electron");
  if (typeof executable !== "string")
    throw Error("Electron executable missing");
  const desktopEnvironment: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const key of Object.keys(desktopEnvironment))
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE")
      delete desktopEnvironment[key];
  const entryArguments = installedExecutable ? [] : [resolve(".")];
  const child = spawn(
    executable,
    ["--remote-debugging-port=0", ...entryArguments],
    {
      env: desktopEnvironment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  const exited = new Promise<number | null>((accept, reject) => {
    child.once("error", reject);
    child.once("exit", accept);
  });
  const endpoint = await new Promise<string>((accept, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(Error("Desktop debugging endpoint did not start")),
      20000,
    );
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      output += chunk.toString();
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        accept(match[1]);
      }
    });
    void exited.then((code) => {
      clearTimeout(timer);
      reject(Error(`Desktop exited during launch (code ${code})`));
    });
  });
  const browser: Browser = await chromium.connectOverCDP(endpoint);
  const first = browser.contexts()[0];
  if (!first) throw Error("Desktop context missing");
  const context = first;
  const windows = () => context.pages().filter((page) => !page.isClosed());
  async function firstWindow(): Promise<Page> {
    const page =
      windows()[0] ?? (await context.waitForEvent("page", { timeout: 45000 }));
    await page.waitForURL(
      (url) => url.protocol === "file:" || url.protocol === "http:",
    );
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => !!window.aster);
    return page;
  }
  return {
    windows,
    firstWindow,
    async reopen() {
      const second = spawn(executable, entryArguments, {
        env: desktopEnvironment,
        windowsHide: true,
        stdio: "ignore",
      });
      await new Promise<void>((accept, reject) => {
        second.once("error", reject);
        second.once("exit", () => accept());
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) {
        await browser.close();
        return;
      }
      const page = windows()[0];
      if (page)
        await page.evaluate(() => {
          void window.aster.windowAction("quit");
        });
      else
        await this.reopen().then(async () => {
          const open = await firstWindow();
          await open.evaluate(() => {
            void window.aster.windowAction("quit");
          });
        });
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error("Desktop exit did not finish in 30 seconds")),
              30000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        await browser.close();
      }
    },
    process: child,
    exited,
  };
}
