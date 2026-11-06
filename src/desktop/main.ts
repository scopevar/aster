import { registerPluginHandlers } from "./ipc/plugin-handlers.js";
import { serveRendererDocument } from "./windows/renderer-document.js";
import { DirectoryConsent } from "./ipc/directory-consent.js";
import { workerRoutes } from "../shared/protocol.js";
import {
  app,
  type BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  Tray,
} from "electron";
import { z } from "zod";
import { homedir, machine } from "node:os";
import { join } from "node:path";
import { resolveAppDataDirectory } from "../platform/app-data-directory.js";
import { ensureDaemon, stopDaemon, daemonStatus } from "../daemon/lifecycle.js";
import { ControlWindow } from "./windows/control-window.js";
import { pathToFileURL } from "node:url";
import { DesktopDiagnostics } from "./native/diagnostics.js";
import { AppError, resultSchema, type Failure } from "../shared/core.js";
import { type Envelope } from "../shared/commands.js";
import type { DesktopPreferences } from "../shared/desktop/preferences.js";
import { diagnosticsSchema } from "../shared/diagnostics.js";
import {
  desktopChannel,
  desktopEventChannel,
  type DesktopData,
  type DesktopMethod,
} from "../shared/ipc-contracts.js";
import { DesktopAppUpdater } from "./updates/app-updater.js";
import { createElectronUpdateClient } from "./updates/electron-update-client.js";
import { registerUpdateHandlers } from "./updates/update-handlers.js";
import {
  loadUpdateRuntime,
  resolveDefaultUpdateChannel,
} from "./updates/update-feed.js";
import { DesktopAttachments } from "./native/attachments.js";
import { readWorker } from "../worker/client.js";
import { DesktopDocuments } from "./native/documents.js";
import { registerFileHandlers } from "./ipc/file-handlers.js";
import { registerTemplateFileHandlers } from "./ipc/template-files.js";
import { parseInput, settle, toFailure } from "./ipc/ipc-result.js";
import { registerNativeHandlers } from "./ipc/native-handlers.js";
import { DesktopPreferenceStore } from "./native/preferences.js";
import { registerQueryHandlers } from "./ipc/query-handlers.js";
import { workerActionForDesktop } from "./ipc/session.js";
import { DesktopShortcut } from "./native/shortcut.js";
import { trayIcon } from "./windows/tray-icon.js";
import { WorkerConnection } from "./worker/worker-connection.js";
import { WorkerFeed } from "./worker/worker-feed.js";
import { RoutineWindowController } from "./windows/routine-window.js";

const dataDirectory = resolveAppDataDirectory({
  configured: process.env.ASTER_DATA_DIR,
  packaged: app.isPackaged,
  home: homedir(),
  xdgDataHome: process.env.XDG_DATA_HOME,
  cwd: process.cwd(),
});
app.setName("Aster");
app.setPath("userData", join(dataDirectory, "desktop"));
const locked = app.requestSingleInstanceLock();
let window: BrowserWindow | null = null,
  tray: Tray | undefined;
let quitting = false;
let exitCode = 0;

function rendererPage() {
  const configured = process.env.ELECTRON_RENDERER_URL?.trim();
  if (!configured)
    return pathToFileURL(join(__dirname, "../renderer/index.html")).href;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("开发 Renderer 地址无效。");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error("开发 Renderer 地址必须是本机 HTTP 地址。");
  return url.href;
}

if (!locked) {
  console.info(
    "Aster 桌面已在运行，已请求现有进程显示窗口。请从托盘选择“打开 Aster”。daemon 生命周期独立于控制端。",
  );
  app.quit();
} else {
  if (process.platform === "win32") app.setAppUserModelId("com.scopevar.aster");
  let controlWindow: ControlWindow | undefined;
  const activateWindow = () => {
    void controlWindow
      ?.open()
      .catch((error: unknown) => console.error("窗口打开失败", error));
  };
  const shortcuts = new DesktopShortcut(globalShortcut, activateWindow);
  const preferences = new DesktopPreferenceStore(
    join(dataDirectory, "desktop", "preferences.json"),
    shortcuts,
  );
  if (!preferences.read().appliedHardwareAcceleration)
    app.disableHardwareAcceleration();
  nativeTheme.themeSource = preferences.read().theme;
  let preferencesFlushed = false;
  let draining: Promise<void> | undefined;
  let feed: WorkerFeed | undefined;
  let routineWindow: RoutineWindowController | undefined;
  let updates: DesktopAppUpdater | undefined;
  const acceptedCommands = new Set<Promise<unknown>>();
  const directoryConsent = new DirectoryConsent();
  const attachments = new DesktopAttachments(dataDirectory);
  const documents = new DesktopDocuments(dataDirectory);
  const startBackground = () =>
    ensureDaemon(dataDirectory, {
      executable: app.isPackaged
        ? process.execPath
        : process.env.ASTER_NODE_BIN || "node",
      script: app.isPackaged
        ? join(
            process.resourcesPath,
            "app.asar.unpacked",
            "node_modules",
            "@aster",
            "cli",
            "dist",
            "cli",
            "main.js",
          )
        : join(app.getAppPath(), "node_modules/@aster/cli/dist/cli/main.js"),
      env: {
        ...process.env,
        ASTER_ELECTRON_BIN: process.execPath,
        ASTER_ELECTRON_APP: app.isPackaged ? undefined : app.getAppPath(),
      },
    });
  const diagnostics = new DesktopDiagnostics(dataDirectory, {
    appVersion: app.getVersion(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron ?? "",
    platform: diagnosticsSchema.shape.platform.parse(process.platform),
    architecture: diagnosticsSchema.shape.architecture.parse(process.arch),
  });
  app.on("second-instance", activateWindow);
  let signalQuit = false;
  const quitFromSignal = () => {
    if (signalQuit) return;
    signalQuit = true;
    // A signal can arrive after the singleton is acquired but before Electron is ready.
    void app.whenReady().then(() => setImmediate(() => app.quit()));
  };
  process.on("SIGINT", quitFromSignal);
  process.on("SIGTERM", quitFromSignal);
  app.once("quit", () => {
    process.removeListener("SIGINT", quitFromSignal);
    process.removeListener("SIGTERM", quitFromSignal);
  });
  app.on("before-quit", (event) => {
    updates?.stop();
    quitting = true;
    directoryConsent.clear();
    shortcuts.close();
    if (!preferencesFlushed) {
      event.preventDefault();
      console.info("正在退出控制端，daemon 保持运行。");
      draining ??= Promise.allSettled([
        ...acceptedCommands,
        feed?.stop(),
        documents.close(),
        diagnostics.close(),
      ]).then(async (results) => {
        for (const result of results)
          if (result.status === "rejected") {
            exitCode = 1;
            console.error("应用退出清理失败", result.reason);
          }
        console.info("控制端连接已释放。");
        await preferences.close();
        preferencesFlushed = true;
        tray?.destroy();
        routineWindow?.dispose();
        window?.destroy();
        console.info("控制端清理完成，正在退出进程。");
        app.exit(exitCode);
      });
      return;
    }
    tray?.destroy();
  });
  app.on("window-all-closed", () => {
    if (workerActionForDesktop("window-closed") === "stop") app.quit();
  });
  void app
    .whenReady()
    .then(async () => {
      if (signalQuit || draining) return;
      await startBackground();
      if (signalQuit || draining) return;
      await readWorker(dataDirectory);
      if (signalQuit || draining) return;
      const worker = new WorkerConnection(dataDirectory);
      const workerCall = (path: string, body?: unknown) =>
        worker.call(path, body);
      const runCommand = async (envelope: Envelope) => {
        if (draining)
          throw new AppError("unavailable", "界面正在退出，命令未接受。");
        if (envelope.command.type === "worker.stop") {
          await stopDaemon(dataDirectory);
          setImmediate(() => app.quit());
          return {};
        }
        const request = workerCall(workerRoutes.command, envelope);
        acceptedCommands.add(request);
        let result;
        try {
          result = resultSchema.parse(await request);
        } finally {
          acceptedCommands.delete(request);
        }
        return result;
      };
      const workerFeed = new WorkerFeed((signal) =>
        worker.stream(workerRoutes.events, signal),
      );
      feed = workerFeed;
      const savedPreferences = preferences.read();
      updates = new DesktopAppUpdater(
        loadUpdateRuntime({
          currentVersion: app.getVersion(),
          isPackaged: app.isPackaged,
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
          platform: process.platform,
          appArch: process.arch,
          hostArch: machine(),
          appImage: process.env.APPIMAGE,
          disabledByEnv: process.env.ASTER_DISABLE_AUTO_UPDATE === "1",
          forceDevUpdate: process.env.ASTER_FORCE_DEV_UPDATE === "1",
          envUrl: process.env.ASTER_UPDATE_URL,
          envRepository: process.env.ASTER_UPDATE_REPOSITORY,
          channel:
            savedPreferences.updateChannel ??
            resolveDefaultUpdateChannel(app.getVersion()),
          autoUpdate: savedPreferences.autoUpdate ?? false,
        }),
        createElectronUpdateClient,
      );
      const page = rendererPage();
      const assertSender = (event: Electron.IpcMainInvokeEvent) => {
        if (window && event.sender === window.webContents) {
          if (event.senderFrame?.url !== page)
            throw new AppError("unauthorized", "不受信任的界面调用。");
          return;
        }
        if (!routineWindow?.isSender(event))
          throw new AppError("unauthorized", "不受信任的界面调用。");
      };
      const handle = <K extends DesktopMethod>(
        method: K,
        run: (...input: unknown[]) => DesktopData<K> | Promise<DesktopData<K>>,
        fallback?: Failure,
      ) =>
        ipcMain.handle(desktopChannel(method), (event, ...input: unknown[]) =>
          settle<DesktopData<K>>(() => {
            assertSender(event);
            return run(...input);
          }, fallback),
        );
      const handlers = {
        handle,
        get quitting() {
          return quitting;
        },
        set quitting(value: boolean) {
          quitting = value;
        },
        get window() {
          return window;
        },
        get draining() {
          return draining;
        },
        acceptedCommands,
        worker,
        workerCall,
        runCommand,
        workerFeed,
        preferences,
        onPreferencesSaved: (saved: DesktopPreferences) => {
          updates?.applyPreferences({
            autoUpdate: saved.autoUpdate ?? false,
            ...(saved.updateChannel
              ? { updateChannel: saved.updateChannel }
              : {}),
          });
        },
        attachments,
        documents,
        diagnostics,
        directoryConsent,
      };
      registerPluginHandlers(handlers);
      registerQueryHandlers(handlers);
      registerFileHandlers(handlers);
      registerTemplateFileHandlers(handlers, dataDirectory);
      registerNativeHandlers(handlers);
      registerUpdateHandlers(handlers, updates, async () => {
        if (await daemonStatus(dataDirectory))
          throw new AppError(
            "conflict",
            "请先明确停止本机 daemon，再安装更新；未自动停止独立任务。",
          );
      });
      routineWindow = new RoutineWindowController({
        page,
        preload: join(__dirname, "preload.cjs"),
        onFocusConversation: (id) => {
          if (quitting || !window || window.isDestroyed()) return;
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          window.webContents.send(desktopEventChannel("focusConversation"), id);
        },
      });
      handle("openRoutineWindow", (botId, routineId) => {
        if (!routineWindow || draining)
          throw new AppError("unavailable", "任务窗口不可用。");
        return routineWindow.open(
          parseInput(z.uuid(), botId),
          routineId === undefined ? undefined : parseInput(z.uuid(), routineId),
        );
      });
      handle("routineWindowAction", (action) => {
        if (!routineWindow || draining)
          throw new AppError("unavailable", "任务窗口不可用。");
        routineWindow.action(
          parseInput(z.enum(["minimize", "maximize", "close"]), action),
        );
      });
      handle("focusConversation", (conversationId) => {
        if (!routineWindow || draining)
          throw new AppError("unavailable", "任务窗口不可用。");
        routineWindow.focusConversation(parseInput(z.uuid(), conversationId));
      });
      controlWindow = new ControlWindow({
        page,
        preload: join(__dirname, "preload.cjs"),
        feed: workerFeed,
        updates,
        closing: () => quitting || !!draining,
        changed: (next) => {
          window = next;
        },
        released: () => {
          directoryConsent.clear();
          routineWindow?.dispose();
        },
      });
      updates.start();
      workerFeed.start();
      tray = new Tray(trayIcon());
      tray.setToolTip("Aster");
      let stoppingWorker = false;
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开 Aster", click: activateWindow },
          {
            label: "只关闭窗口（轻量模式）",
            click: () => {
              controlWindow?.release();
            },
          },
          {
            label: "停止 daemon 并关闭",
            click: () => {
              if (stoppingWorker || draining) return;
              stoppingWorker = true;
              void stopDaemon(dataDirectory)
                .then(() => app.quit())
                .catch((error: unknown) => {
                  const failure = toFailure(error, {
                    code: "unknown",
                    message: "无法确认停止结果，请检查后台状态后重试。",
                  });
                  dialog.showErrorBox("停止 daemon 失败", failure.message);
                })
                .finally(() => {
                  stoppingWorker = false;
                });
            },
          },
          { label: "退出控制端", click: () => app.quit() },
        ]),
      );
      tray.on("click", activateWindow);
      shortcuts.start(preferences.read().shortcut);
      if (page.startsWith("file:"))
        serveRendererDocument(
          (await import("electron")).session.defaultSession,
          page,
        );
      await controlWindow.open();
      if (signalQuit || draining) return;
      console.info("Aster 桌面窗口已打开。");
    })
    .catch((error) => {
      if (signalQuit || draining) return;
      exitCode = 1;
      console.error("Desktop startup failed", error);
      console.error(
        app.isPackaged
          ? "安装版启动失败。请按上方原因处理后重新打开 Aster。"
          : "请执行 pnpm dev --doctor 检查环境；修正后执行 pnpm dev；已有 daemon 不自动停止。",
      );
      dialog.showErrorBox(
        "Aster 启动失败",
        error instanceof Error ? error.message : "未知错误",
      );
      app.quit();
    });
}
