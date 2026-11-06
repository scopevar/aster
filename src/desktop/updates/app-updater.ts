import {
  appUpdateStateSchema,
  type AppUpdateState,
  type UpdateChannel,
} from "../../shared/desktop/app-update.js";
import { AppError } from "../../shared/core.js";
import { compareReleaseVersions } from "../../shared/desktop/release-version.js";
import type { UpdateFeed } from "../../shared/desktop/update-source.js";
import {
  channelFeedUrl,
  isNightlyVersion,
  resolveDefaultUpdateChannel,
  type UpdateRuntime,
} from "./update-feed.js";

const CHECK_FAILED = "检查更新失败。";
const DOWNLOAD_FAILED = "下载更新失败。";
const INSTALL_FAILED = "安装更新失败。";
const BUSY = "已有更新操作正在进行。";
const NO_DOWNLOAD = "没有可下载的更新。";
const NOT_READY = "更新尚未下载完成。";
const CLIENT_FAILED = "更新组件未能加载。";

export type UpdateFeedHandlers = {
  error(): void;
  checking(): void;
  available(version: string): void;
  notAvailable(): void;
  downloaded(version: string): void;
  progress(percent: number): void;
};

export type UpdateFeedClient = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string | null;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  fullChangelog: boolean;
  disableDifferentialDownload: boolean;
  forceDevUpdateConfig: boolean;
  setFeedURL(options: UpdateFeed): void;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
  bind(handlers: UpdateFeedHandlers): () => void;
};

export type UpdateClock = {
  setTimeout(run: () => void, ms: number): { clear(): void };
  setInterval(run: () => void, ms: number): { clear(): void };
};

const nodeClock: UpdateClock = {
  setTimeout(run, ms) {
    const timer = setTimeout(run, ms);
    return { clear: () => clearTimeout(timer) };
  },
  setInterval(run, ms) {
    const timer = setInterval(run, ms);
    return { clear: () => clearInterval(timer) };
  },
};

type UpdateAction = "check" | "download" | "install" | "channel";

export class DesktopAppUpdater {
  private runtime: UpdateRuntime;
  private state: AppUpdateState;
  private readonly listeners = new Set<(state: AppUpdateState) => void>();
  private client: UpdateFeedClient | null = null;
  private unbind: (() => void) | null = null;
  private action: UpdateAction | null = null;
  private started = false;
  private firstTimer: { clear(): void } | null = null;
  private pollTimer: { clear(): void } | null = null;
  private lastMilestone = -1;

  constructor(
    runtime: UpdateRuntime,
    private readonly createClient: () => UpdateFeedClient,
    private readonly clock: UpdateClock = nodeClock,
  ) {
    this.runtime = runtime;
    const enabled = runtime.disabledReason === null && runtime.feed !== null;
    this.state = appUpdateStateSchema.parse({
      enabled,
      status: enabled ? "idle" : "disabled",
      channel: runtime.channel,
      currentVersion: acceptVersion(runtime.currentVersion),
      availableVersion: null,
      downloadedVersion: null,
      downloadPercent: null,
      message: null,
      disabledReason: runtime.disabledReason,
    });
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (!this.state.enabled || !this.runtime.feed) return;
    try {
      const client = this.createClient();
      client.autoDownload = false;
      client.autoInstallOnAppQuit = false;
      client.forceDevUpdateConfig = this.runtime.forceDevUpdateConfig;
      client.fullChangelog = true;
      this.applyChannel(client, this.runtime.channel);
      this.unbind = client.bind({
        error: () => this.onError(),
        checking: () => undefined,
        available: (version) => this.onAvailable(version),
        notAvailable: () => this.onNotAvailable(),
        downloaded: (version) => this.onDownloaded(version),
        progress: (percent) => this.onProgress(percent),
      });
      this.client = client;
    } catch {
      this.commit({
        enabled: false,
        status: "disabled",
        disabledReason: CLIENT_FAILED,
        availableVersion: null,
        downloadedVersion: null,
        downloadPercent: null,
        message: null,
      });
      return;
    }
    this.reschedule();
  }

  stop() {
    this.firstTimer?.clear();
    this.pollTimer?.clear();
    this.firstTimer = null;
    this.pollTimer = null;
    this.unbind?.();
    this.unbind = null;
    this.client = null;
    this.started = false;
  }

  subscribe(listener: (state: AppUpdateState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): AppUpdateState {
    return this.state;
  }

  applyPreferences(input: {
    updateChannel?: UpdateChannel;
    autoUpdate: boolean;
  }) {
    if (this.action === "install") return;
    const nextChannel = input.updateChannel ?? this.runtime.channel;
    const channelChanged = nextChannel !== this.runtime.channel;
    const autoChanged = input.autoUpdate !== this.runtime.autoUpdate;
    this.runtime = {
      ...this.runtime,
      channel: nextChannel,
      autoUpdate: input.autoUpdate,
    };
    if (!channelChanged) {
      if (autoChanged && this.started) this.reschedule();
      return;
    }
    if (this.client && this.state.enabled)
      this.applyChannel(this.client, nextChannel);
    this.commit({
      channel: nextChannel,
      ...(this.state.enabled
        ? {
            status: "idle" as const,
            availableVersion: null,
            downloadedVersion: null,
            downloadPercent: null,
            message: null,
          }
        : {}),
    });
    if (this.state.enabled) void this.recheckForChannel();
    if (autoChanged && this.started) this.reschedule();
  }

  async check() {
    this.assertIdle();
    const client = this.client;
    if (!client)
      throw new AppError(
        "unavailable",
        this.state.disabledReason ?? CLIENT_FAILED,
      );
    this.action = "check";
    this.commit({ status: "checking", message: null });
    try {
      await client.checkForUpdates();
    } catch {
      if (this.state.status !== "error")
        this.commit({ status: "error", message: CHECK_FAILED });
    } finally {
      if (this.action === "check") this.action = null;
    }
    return this.state;
  }

  async download() {
    this.assertIdle();
    if (!this.state.availableVersion || this.state.downloadedVersion)
      throw new AppError("invalid_input", NO_DOWNLOAD);
    const client = this.client;
    if (!client)
      throw new AppError(
        "unavailable",
        this.state.disabledReason ?? CLIENT_FAILED,
      );
    this.action = "download";
    this.lastMilestone = 0;
    this.commit({ status: "downloading", downloadPercent: 0, message: null });
    try {
      await client.downloadUpdate();
    } catch {
      if (this.state.status !== "error")
        this.commit({
          status: "error",
          message: DOWNLOAD_FAILED,
          downloadPercent: null,
        });
    } finally {
      if (this.action === "download") this.action = null;
    }
    return this.state;
  }

  beginInstall() {
    this.assertIdle();
    if (this.state.status !== "downloaded" || !this.state.downloadedVersion)
      throw new AppError("invalid_input", NOT_READY);
    this.action = "install";
    this.commit({ status: "preparing", message: "正在确认后台工作状态…" });
  }

  prepareInstall(message: string, stopping = false) {
    if (this.action === "install")
      this.commit({ status: stopping ? "installing" : "preparing", message });
  }

  cancelInstall(message: string | null = null) {
    if (this.action === "install") {
      this.action = null;
      this.commit({ status: "downloaded", message });
    } else if (message && this.state.downloadedVersion)
      this.commit({ status: "downloaded", message });
  }

  finishInstall() {
    const client = this.client;
    if (!client || this.action !== "install") {
      this.action = null;
      this.commit({ status: "error", message: INSTALL_FAILED });
      return this.state;
    }
    try {
      client.quitAndInstall(true, true);
    } catch {
      this.commit({ status: "error", message: INSTALL_FAILED });
    }
    if (this.state.status === "error") this.action = null;
    return this.state;
  }

  private applyChannel(client: UpdateFeedClient, channel: UpdateChannel) {
    client.channel = channel;
    const nightly = channel === "nightly";
    client.allowPrerelease = nightly;
    client.allowDowngrade = false;
    client.fullChangelog = true;
    client.disableDifferentialDownload =
      this.runtime.disableDifferentialDownload ||
      channel !== resolveDefaultUpdateChannel(this.runtime.currentVersion);
    const feed = this.runtime.feed;
    if (feed)
      client.setFeedURL(
        feed.provider === "github"
          ? feed
          : { ...feed, url: channelFeedUrl(feed.url, channel) },
      );
  }

  private async recheckForChannel() {
    const client = this.client;
    if (!client || !this.state.enabled || this.action) return;
    this.action = "channel";
    this.commit({ status: "checking", message: null });
    try {
      await client.checkForUpdates();
    } catch {
      if (this.state.status !== "error")
        this.commit({ status: "error", message: CHECK_FAILED });
    } finally {
      if (this.action === "channel") this.action = null;
    }
  }

  private assertIdle() {
    if (!this.state.enabled || !this.client)
      throw new AppError(
        "unavailable",
        this.state.disabledReason ?? CLIENT_FAILED,
      );
    if (this.action) throw new AppError("conflict", BUSY);
  }

  private onError() {
    const message =
      this.action === "download"
        ? DOWNLOAD_FAILED
        : this.action === "install"
          ? INSTALL_FAILED
          : CHECK_FAILED;
    this.commit({
      status: "error",
      message,
      ...(this.action === "download" ? { downloadPercent: null } : {}),
    });
  }

  private onAvailable(version: string) {
    if (!this.accepts(version)) {
      this.commit({
        status: "up-to-date",
        availableVersion: null,
        message: null,
      });
      return;
    }
    const already = this.state.downloadedVersion === version;
    this.commit({
      status: already ? "downloaded" : "available",
      availableVersion: version,
      downloadedVersion: already ? version : null,
      downloadPercent: already ? 100 : null,
      message: null,
    });
  }

  private onNotAvailable() {
    this.commit({
      status: "up-to-date",
      availableVersion: null,
      downloadedVersion: null,
      downloadPercent: null,
      message: null,
    });
  }

  private onDownloaded(version: string) {
    if (!this.accepts(version)) return;
    this.commit({
      status: "downloaded",
      availableVersion: version,
      downloadedVersion: version,
      downloadPercent: 100,
      message: null,
    });
  }

  private onProgress(percent: number) {
    const value = Number.isFinite(percent)
      ? Math.min(100, Math.max(0, percent))
      : 0;
    const bucket = value >= 100 ? 100 : Math.floor(value / 10);
    const shown = bucket === 100 ? 100 : bucket * 10;
    this.state = appUpdateStateSchema.parse({
      ...this.state,
      status: "downloading",
      downloadPercent: shown,
      message: null,
    });
    if (bucket === this.lastMilestone) return;
    this.lastMilestone = bucket;
    this.emit();
  }

  private accepts(version: string) {
    try {
      return (
        isNightlyVersion(version) === (this.runtime.channel === "nightly") &&
        compareReleaseVersions(version, this.runtime.currentVersion) > 0
      );
    } catch {
      return false;
    }
  }

  private reschedule() {
    this.firstTimer?.clear();
    this.pollTimer?.clear();
    this.firstTimer = null;
    this.pollTimer = null;
    if (!this.started || !this.state.enabled || !this.runtime.autoUpdate)
      return;
    this.firstTimer = this.clock.setTimeout(() => this.safeCheck(), 15_000);
    this.pollTimer = this.clock.setInterval(() => this.safeCheck(), 240_000);
  }

  private safeCheck() {
    if (this.action || !this.client || !this.state.enabled) return;
    void this.check();
  }

  private commit(patch: Partial<AppUpdateState>) {
    this.state = appUpdateStateSchema.parse({ ...this.state, ...patch });
    this.emit();
  }

  private emit() {
    const snapshot = this.state;
    for (const listener of this.listeners) listener(snapshot);
  }
}

function acceptVersion(version: string) {
  return /^[0-9A-Za-z.+-]{1,64}$/.test(version) ? version : "0.0.0";
}
