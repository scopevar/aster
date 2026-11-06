import { test as base, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Store } from "../../src/storage/store.js";
import { AppError } from "../../src/shared/core.js";
import {
  createDesktopBridge,
  desktopEventChannel,
  type DesktopArgs,
  type DesktopEvent,
  type DesktopEvents,
  type DesktopMethod,
} from "../../src/shared/ipc-contracts.js";
import { mainHandlers, type Handlers } from "./renderer-main.js";
import { storeHandlers } from "./renderer-store.js";

export type { Handlers } from "./renderer-main.js";
export type RendererApp = {
  /** The page's local data behind a signed-in fake account, opened on first use. */
  store(): Store;
  open(options?: {
    handlers?: Handlers;
    colorScheme?: "light" | "dark";
    size?: { width: number; height: number };
  }): Promise<Page>;
  emit<K extends DesktopEvent>(
    event: K,
    payload: DesktopEvents[K],
  ): Promise<void>;
  /** Text the page asked Main to copy. */
  copied: string[];
  /** Bridge methods the page called without a handler. */
  unhandled: DesktopMethod[];
};

// Secure context like Electron's file:// page, so crypto.randomUUID exists; every request is fulfilled locally.
const origin = "https://aster.test";
const methods: ReadonlySet<string> = new Set(
  Object.keys(createDesktopBridge(() => Promise.reject(Error("unused")))),
);
const isMethod = (name: string): name is DesktopMethod => methods.has(name);
let bridgeScript: Promise<string> | undefined;
function bundleBridge() {
  return (bridgeScript ??= build({
    entryPoints: [resolve("tests/helpers/renderer-bridge.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    logLevel: "silent",
  }).then((result) => {
    const output = result.outputFiles[0];
    if (!output) throw Error("Renderer bridge bundle is empty");
    return output.text;
  }));
}

async function dispatch<K extends DesktopMethod>(
  handlers: Handlers,
  method: K,
  args: DesktopArgs<K>,
  unhandled: DesktopMethod[],
) {
  const handler = handlers[method];
  if (!handler) {
    unhandled.push(method);
    return {
      success: false,
      error: { code: "unavailable", message: `测试未提供 ${method}。` },
    };
  }
  try {
    return { success: true, data: await handler(...args) };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return {
      success: false,
      error: { code: error.code, message: error.message },
    };
  }
}

function serveRenderer(page: Page) {
  const root = resolve("dist/renderer");
  return page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = resolve(root, `.${decodeURIComponent(path)}`);
    if (url.origin !== origin || relative(root, file).startsWith(".."))
      return route.abort();
    await route
      .fulfill({ path: file })
      .catch(() => route.fulfill({ status: 404 }));
  });
}
/** The built renderer and a real Store behind a fake bridge: no Electron, worker, daemon or network. */
export const test = base.extend<{ renderer: RendererApp }>({
  renderer: async ({ page }, use) => {
    const results = resolve(".runtime/test-results");
    await mkdir(results, { recursive: true });
    const directory = await mkdtemp(join(results, "renderer-"));
    const errors: string[] = [];
    let store: Store | undefined;
    let closed = false;
    const app: RendererApp = {
      copied: [],
      unhandled: [],
      store: () => (store ??= new Store(join(directory, "aster.sqlite"))),
      async emit(event, payload) {
        await page.evaluate(
          ([channel, value]) => window.__asterEmit(channel, value),
          [desktopEventChannel(event), payload] as const,
        );
      },
      async open(options = {}) {
        const handlers: Handlers = {
          ...mainHandlers(app.copied),
          ...storeHandlers(app.store, (signal) =>
            app.emit("workerSignal", signal),
          ),
          ...options.handlers,
        };
        await page.exposeBinding(
          "__asterInvoke",
          async (_source, channel: unknown, args: unknown) => {
            const method =
              typeof channel === "string" ? channel.replace(/^aster:/, "") : "";
            if (!isMethod(method) || !Array.isArray(args))
              throw Error(`Unknown bridge call ${String(channel)}`);
            // Calls still in flight while the fixture tears down meet a stopped backend.
            if (closed)
              return {
                success: false,
                error: { code: "unavailable", message: "测试已结束。" },
              };
            try {
              // The caller is createDesktopBridge, typed per method; Playwright only clones values.
              return await dispatch(
                handlers,
                method,
                args as DesktopArgs<typeof method>,
                app.unhandled,
              );
            } catch (error) {
              errors.push(`${method}: ${String(error)}`);
              return {
                success: false,
                error: { code: "unknown", message: "测试处理器失败。" },
              };
            }
          },
        );
        await page.addInitScript({ content: await bundleBridge() });
        await serveRenderer(page);
        if (options.colorScheme)
          await page.emulateMedia({ colorScheme: options.colorScheme });
        if (options.size) await page.setViewportSize(options.size);
        await page.goto(`${origin}/`);
        return page;
      },
    };
    try {
      await use(app);
    } finally {
      closed = true;
      store?.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 10 });
    }
    if (errors.length)
      throw Error(`Renderer handlers failed:\n${errors.join("\n")}`);
  },
});

export { expect } from "@playwright/test";
