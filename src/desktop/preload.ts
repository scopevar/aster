import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  createDesktopBridge,
  createDesktopSubscriptions,
} from "../shared/ipc-contracts.js";

contextBridge.exposeInMainWorld(
  "aster",
  createDesktopBridge((channel, ...args) =>
    ipcRenderer.invoke(channel, ...args),
  ),
);

contextBridge.exposeInMainWorld(
  "asterEvents",
  createDesktopSubscriptions((channel, listener) => {
    // [Security]: 只转发载荷，IpcRendererEvent 带有 sender 等对象，不能越过 contextBridge 交给页面。
    const forward = (_event: IpcRendererEvent, payload: unknown) =>
      listener(payload);
    ipcRenderer.on(channel, forward);
    return () => {
      ipcRenderer.removeListener(channel, forward);
    };
  }),
);
