import type {
  DesktopArgs,
  DesktopData,
  DesktopMethod,
} from "../../src/shared/ipc-contracts.js";

/** Replaces Main for one page; unset methods fail like an unavailable backend and are recorded. */
export type Handlers = {
  [K in DesktopMethod]?: (
    ...args: DesktopArgs<K>
  ) => DesktopData<K> | Promise<DesktopData<K>>;
};

/** Main's own answers that need no worker: default preferences and the clipboard. */
export function mainHandlers(copied: string[]): Handlers {
  return {
    preferences: () => ({
      version: 3,
      revision: 0,
      hardwareAcceleration: true,
      appliedHardwareAcceleration: true,
      timeZone: "auto",
      theme: "system",
      shortcut: null,
      shortcutStatus: { state: "disabled", detail: "" },
    }),
    copyText: (text) => {
      copied.push(text);
    },
  };
}
