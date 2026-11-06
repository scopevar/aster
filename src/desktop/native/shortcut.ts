import { AppError } from "../../shared/core.js";
import {
  shortcutAccelerator,
  type Shortcut,
} from "../../shared/desktop/shortcut.js";

type Registration = {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
};
/** Owns only this feature's registrations. A reserved key is inert until the file commits. */
export class DesktopShortcut {
  private current: string | null = null;
  private owned = new Set<string>();
  private ready = false;
  private closed = false;
  private detail = "快捷键尚未初始化。";
  constructor(
    private readonly native: Registration,
    private readonly activate: () => void,
  ) {}
  start(value: Shortcut | null) {
    if (this.closed) return;
    this.ready = true;
    try {
      this.prepare(value).commit();
    } catch (error) {
      this.detail =
        error instanceof AppError ? error.message : "快捷键注册失败，请重试。";
    }
  }
  status(value: Shortcut | null) {
    if (!value)
      return { state: "disabled" as const, detail: "全局快捷键已关闭。" };
    const key = shortcutAccelerator(value);
    if (
      this.ready &&
      !this.closed &&
      this.current === key &&
      this.native.isRegistered(key)
    )
      return {
        state: "active" as const,
        detail: "应用在后台时也可打开窗口；退出应用后释放。",
      };
    return {
      state: "unavailable" as const,
      detail: this.detail || "快捷键未生效，请重试或更换组合。",
    };
  }
  prepare(value: Shortcut | null) {
    if (!this.ready || this.closed)
      throw new AppError("unavailable", "快捷键服务尚未就绪或正在关闭。");
    const next = value ? shortcutAccelerator(value) : null;
    const previous = this.current;
    const needsRegistration =
      next !== null && (next !== previous || !this.native.isRegistered(next));
    if (needsRegistration && next) {
      let registered = false;
      try {
        registered = this.native.register(next, () => {
          if (!this.closed && this.current === next) this.activate();
        });
      } catch {
        throw new AppError("unavailable", "系统无法注册此快捷键，请更换组合。");
      }
      if (!registered)
        throw new AppError(
          "conflict",
          "快捷键已被其他应用占用或系统不支持，请更换组合后重试。",
        );
      this.owned.add(next);
    }
    let settled = false;
    return {
      commit: () => {
        if (settled) return;
        settled = true;
        if (this.closed) return;
        if (previous && previous !== next) this.release(previous);
        this.current = next;
        this.detail = "";
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        if (needsRegistration && next) this.release(next);
      },
    };
  }
  private release(key: string) {
    this.native.unregister(key);
    this.owned.delete(key);
  }
  close() {
    this.closed = true;
    this.detail = "界面正在退出，快捷键已释放。";
    for (const key of this.owned) this.release(key);
    this.current = null;
  }
}
