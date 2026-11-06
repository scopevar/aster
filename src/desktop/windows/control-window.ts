import { BrowserWindow, nativeTheme } from "electron";
import { applicationIcon } from "./tray-icon.js";
import { desktopEventChannel } from "../../shared/ipc-contracts.js";
import type { WorkerFeed } from "../worker/worker-feed.js";
import type { DesktopAppUpdater } from "../updates/app-updater.js";

/** Closing destroys the renderer; opening recreates it from persisted state. */
export class ControlWindow {
  private opening: Promise<void> | undefined;
  window: BrowserWindow | null = null;
  constructor(
    private readonly options: {
      page: string;
      preload: string;
      feed: WorkerFeed;
      updates: DesktopAppUpdater;
      closing(): boolean;
      changed(window: BrowserWindow | null): void;
      released(): void;
    },
  ) {}
  open() {
    if (this.options.closing()) return Promise.resolve();
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      return Promise.resolve();
    }
    return (this.opening ??= this.create().finally(() => {
      this.opening = undefined;
    }));
  }
  release() {
    this.window?.close();
  }
  private async create() {
    const { page, preload, feed, updates } = this.options;
    const window = new BrowserWindow({
      width: 1050,
      height: 768,
      minWidth: 760,
      minHeight: 550,
      frame: false,
      show: false,
      title: "Aster",
      icon: applicationIcon(),
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#060607" : "#ffffff",
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = window;
    this.options.changed(window);
    const theme = () => {
      if (!window.isDestroyed())
        window.setBackgroundColor(
          nativeTheme.shouldUseDarkColors ? "#060607" : "#ffffff",
        );
    };
    nativeTheme.on("updated", theme);
    const stopFeed = feed.subscribe((signal) => {
      if (!window.isDestroyed())
        window.webContents.send(desktopEventChannel("workerSignal"), signal);
    });
    const stopUpdates = updates.subscribe((state) => {
      if (!window.isDestroyed())
        window.webContents.send(desktopEventChannel("appUpdate"), state);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    window.once("closed", () => {
      nativeTheme.removeListener("updated", theme);
      stopFeed();
      stopUpdates();
      if (this.window === window) {
        this.window = null;
        this.options.changed(null);
        this.options.released();
      }
    });
    await window.loadURL(page);
    if (!window.isDestroyed() && !this.options.closing()) window.show();
  }
}
