import {
  autoUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from "electron-updater";
import type { UpdateFeedClient, UpdateFeedHandlers } from "./app-updater.js";

/** 生产环境唯一导入 electron-updater 的模块，便于测试注入假客户端。 */
export function createElectronUpdateClient(): UpdateFeedClient {
  autoUpdater.logger = null;
  return {
    get autoDownload() {
      return autoUpdater.autoDownload;
    },
    set autoDownload(value) {
      autoUpdater.autoDownload = value;
    },
    get autoInstallOnAppQuit() {
      return autoUpdater.autoInstallOnAppQuit;
    },
    set autoInstallOnAppQuit(value) {
      autoUpdater.autoInstallOnAppQuit = value;
    },
    get channel() {
      return autoUpdater.channel;
    },
    set channel(value) {
      autoUpdater.channel = value;
    },
    get allowPrerelease() {
      return autoUpdater.allowPrerelease;
    },
    set allowPrerelease(value) {
      autoUpdater.allowPrerelease = value;
    },
    get allowDowngrade() {
      return autoUpdater.allowDowngrade;
    },
    set allowDowngrade(value) {
      autoUpdater.allowDowngrade = value;
    },
    get fullChangelog() {
      return autoUpdater.fullChangelog;
    },
    set fullChangelog(value) {
      autoUpdater.fullChangelog = value;
    },
    get disableDifferentialDownload() {
      return autoUpdater.disableDifferentialDownload;
    },
    set disableDifferentialDownload(value) {
      autoUpdater.disableDifferentialDownload = value;
    },
    get forceDevUpdateConfig() {
      return autoUpdater.forceDevUpdateConfig;
    },
    set forceDevUpdateConfig(value) {
      autoUpdater.forceDevUpdateConfig = value;
    },
    setFeedURL(options) {
      autoUpdater.setFeedURL(options);
    },
    async checkForUpdates() {
      await autoUpdater.checkForUpdates();
    },
    async downloadUpdate() {
      await autoUpdater.downloadUpdate();
    },
    quitAndInstall(isSilent, isForceRunAfter) {
      autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
    },
    bind(handlers: UpdateFeedHandlers) {
      const onError = () => handlers.error();
      const onChecking = () => handlers.checking();
      const onAvailable = (info: UpdateInfo) =>
        handlers.available(info.version);
      const onNotAvailable = () => handlers.notAvailable();
      const onDownloaded = (event: UpdateDownloadedEvent) =>
        handlers.downloaded(event.version);
      const onProgress = (info: ProgressInfo) =>
        handlers.progress(info.percent);
      autoUpdater.on("error", onError);
      autoUpdater.on("checking-for-update", onChecking);
      autoUpdater.on("update-available", onAvailable);
      autoUpdater.on("update-not-available", onNotAvailable);
      autoUpdater.on("update-downloaded", onDownloaded);
      autoUpdater.on("download-progress", onProgress);
      return () => {
        autoUpdater.removeListener("error", onError);
        autoUpdater.removeListener("checking-for-update", onChecking);
        autoUpdater.removeListener("update-available", onAvailable);
        autoUpdater.removeListener("update-not-available", onNotAvailable);
        autoUpdater.removeListener("update-downloaded", onDownloaded);
        autoUpdater.removeListener("download-progress", onProgress);
      };
    },
  };
}
