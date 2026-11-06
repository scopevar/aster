import { BrowserWindow, nativeTheme, type IpcMainInvokeEvent } from "electron";
import { AppError } from "../../shared/core.js";
import { applicationIcon } from "./tray-icon.js";

export class RoutineWindowController {
  private window: BrowserWindow | null = null;
  private url: string | null = null;
  private generation = 0;

  constructor(
    private readonly options: {
      page: string;
      preload: string;
      onFocusConversation(id: string): void;
    },
  ) {}

  private pageUrl(botId: string, routineId?: string) {
    const url = new URL("./routines.html", this.options.page);
    url.searchParams.set("view", "routines");
    url.searchParams.set("botId", botId);
    if (routineId) url.searchParams.set("routineId", routineId);
    return url.href;
  }

  isSender(event: IpcMainInvokeEvent) {
    return (
      !!this.window &&
      !this.window.isDestroyed() &&
      event.sender === this.window.webContents &&
      event.senderFrame?.url === this.url
    );
  }

  async open(botId: string, routineId?: string) {
    const generation = ++this.generation;
    const url = this.pageUrl(botId, routineId);
    if (this.window && !this.window.isDestroyed()) {
      if (this.url !== url) {
        this.url = url;
        try {
          await this.window.loadURL(url);
        } catch (error) {
          if (generation === this.generation) this.url = null;
          throw error;
        }
      }
      if (generation !== this.generation || this.window.isDestroyed()) return;
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 760,
      height: 700,
      minWidth: 560,
      minHeight: 480,
      show: true,
      frame: false,
      autoHideMenuBar: true,
      backgroundColor: this.background(),
      title: "例行任务",
      icon: applicationIcon(),
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.url = url;
    this.window = window;
    let closing = false;
    window.once("close", () => {
      closing = true;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.once("closed", () => {
      if (this.window === window) {
        this.window = null;
        this.url = null;
      }
    });
    try {
      await window.loadURL(url);
    } catch (error) {
      // A visible loading window can be closed before its page finishes loading.
      if (closing || generation !== this.generation || window.isDestroyed())
        return;
      window.destroy();
      throw error;
    }
  }

  action(action: "minimize" | "maximize" | "close") {
    const window = this.window;
    if (!window || window.isDestroyed())
      throw new AppError("unavailable", "任务窗口已关闭。");
    if (action === "minimize") window.minimize();
    else if (action === "close") window.close();
    else if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  }

  focusConversation(id: string) {
    this.options.onFocusConversation(id);
  }

  updateTheme() {
    if (this.window && !this.window.isDestroyed())
      this.window.setBackgroundColor(this.background());
  }

  dispose() {
    this.generation++;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.url = null;
  }

  private background() {
    return nativeTheme.shouldUseDarkColors ? "#060607" : "#ffffff";
  }
}
