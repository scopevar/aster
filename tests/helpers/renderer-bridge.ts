// Browser entry bundled by renderer-app.ts. It builds window.aster with the same
// factories as preload, so the method list cannot drift from the IPC contract.
import {
  createDesktopBridge,
  createDesktopSubscriptions,
  type DesktopChannel,
  type DesktopEventChannel,
} from "../../src/shared/ipc-contracts.js";

declare global {
  interface Window {
    // Exposed by Playwright; like ipcRenderer.invoke, the reply is typed by the caller.
    __asterInvoke<T>(channel: DesktopChannel, args: unknown[]): Promise<T>;
    __asterEmit(channel: DesktopEventChannel, payload: unknown): void;
  }
}

const listeners = new Map<
  DesktopEventChannel,
  Set<(payload: unknown) => void>
>();

Object.defineProperty(window, "aster", {
  value: createDesktopBridge((channel, ...args) =>
    window.__asterInvoke(channel, args),
  ),
});
Object.defineProperty(window, "asterEvents", {
  value: createDesktopSubscriptions((channel, listener) => {
    const set = listeners.get(channel) ?? new Set();
    listeners.set(channel, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }),
});
Object.defineProperty(window, "__asterEmit", {
  value: (channel: DesktopEventChannel, payload: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  },
});
