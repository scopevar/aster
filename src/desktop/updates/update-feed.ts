import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  UPDATE_FEED_MISSING,
  type UpdateChannel,
} from "../../shared/desktop/app-update.js";
import {
  parseGitHubUpdateFeed,
  type UpdateFeed,
} from "../../shared/desktop/update-source.js";

export const UPDATE_FEED_UNREADABLE = "更新清单无法读取。";
export const UPDATE_FEED_UNSUPPORTED = "更新源类型不受支持，不能检查更新。";
export const UPDATE_FEED_BAD_URL = "更新源地址无效。";
export const UPDATE_UNPACKAGED = "自动更新只在已打包的正式版本中可用。";
export const UPDATE_DISABLED_ENV =
  "已通过 ASTER_DISABLE_AUTO_UPDATE 关闭自动更新。";
export const UPDATE_LINUX_PACKAGE =
  "Linux 自动更新需要 AppImage 或 deb 安装包。";

const NIGHTLY_VERSION = /^\d+\.\d+\.\d+-nightly\.\d{8}\.[1-9]\d*$/;

export type UpdateRuntime = {
  currentVersion: string;
  feed: UpdateFeed | null;
  disabledReason: string | null;
  channel: UpdateChannel;
  autoUpdate: boolean;
  disableDifferentialDownload: boolean;
  forceDevUpdateConfig: boolean;
};

export function isNightlyVersion(version: string) {
  return NIGHTLY_VERSION.test(version);
}

export function resolveDefaultUpdateChannel(version: string): UpdateChannel {
  return isNightlyVersion(version) ? "nightly" : "latest";
}

/** Keep custom legacy feeds intact; official feeds use sibling channel directories. */
export function channelFeedUrl(feedUrl: string, channel: UpdateChannel) {
  const url = new URL(feedUrl);
  url.pathname = url.pathname.replace(
    /\/(stable|nightly)\/$/,
    `/${channel === "latest" ? "stable" : "nightly"}/`,
  );
  return url.href;
}

/** arm64 宿主上的 x64 包走差分下载会拿错 blockmap，改为整包。 */
export function shouldDisableDifferentialDownload(
  hostArch: string,
  appArch: string,
) {
  const host = hostArch.toLowerCase();
  return (host === "arm64" || host === "aarch64") && appArch === "x64";
}

export function parseUpdateManifest(raw: string) {
  try {
    const value: unknown = parse(raw);
    return z
      .object({
        provider: z.string().optional(),
        url: z.string().optional(),
        owner: z.string().optional(),
        repo: z.string().optional(),
      })
      .parse(value);
  } catch {
    return null;
  }
}

/** HTTPS，或 localhost / 127.0.0.1 的 HTTP。拒绝用户信息、查询和片段。 */
export function normalizeGenericFeedUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(stripQuotes(raw.trim()));
  } catch {
    return null;
  }
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localHttp) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

export function resolveUpdateAvailability(input: {
  ymlRaw: string | null;
  ymlUnreadable: boolean;
  envUrl: string | null;
  envRepository?: string | null | undefined;
  isPackaged: boolean;
  forceDevUpdate: boolean;
  disabledByEnv: boolean;
  platform: string;
  appImage: string | null;
  isDebPackage: boolean;
}) {
  const feed = resolveFeed(input);
  if (feed.disabledReason || !feed.feed)
    return { feed: null, disabledReason: feed.disabledReason };
  if (!input.isPackaged && !input.forceDevUpdate)
    return { feed: null, disabledReason: UPDATE_UNPACKAGED };
  if (input.disabledByEnv)
    return { feed: null, disabledReason: UPDATE_DISABLED_ENV };
  if (input.platform === "linux" && !input.appImage && !input.isDebPackage)
    return { feed: null, disabledReason: UPDATE_LINUX_PACKAGE };
  return { feed: feed.feed, disabledReason: null };
}

export function loadUpdateRuntime(input: {
  currentVersion: string;
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  platform: string;
  appArch: string;
  hostArch: string;
  appImage: string | undefined;
  disabledByEnv: boolean;
  forceDevUpdate: boolean;
  envUrl: string | undefined;
  envRepository?: string | undefined;
  channel: UpdateChannel;
  autoUpdate: boolean;
}): UpdateRuntime {
  const ymlPath = input.isPackaged
    ? join(input.resourcesPath, "app-update.yml")
    : join(input.appPath, "dev-app-update.yml");
  const yml = readText(ymlPath);
  const packageType = readText(join(input.resourcesPath, "package-type"));
  const availability = resolveUpdateAvailability({
    ymlRaw: yml.text,
    ymlUnreadable: yml.unreadable,
    envUrl: input.envUrl ?? null,
    envRepository: input.envRepository,
    isPackaged: input.isPackaged,
    forceDevUpdate: input.forceDevUpdate,
    disabledByEnv: input.disabledByEnv,
    platform: input.platform,
    appImage: input.appImage?.trim() ? input.appImage : null,
    isDebPackage: (packageType.text ?? "").trim() === "deb",
  });
  const enabled =
    availability.disabledReason === null && availability.feed !== null;
  return {
    currentVersion: input.currentVersion,
    feed: availability.feed,
    disabledReason: availability.disabledReason,
    channel: input.channel,
    autoUpdate: input.autoUpdate,
    disableDifferentialDownload: shouldDisableDifferentialDownload(
      input.hostArch,
      input.appArch,
    ),
    forceDevUpdateConfig: enabled && !input.isPackaged,
  };
}

function resolveFeed(input: {
  ymlRaw: string | null;
  ymlUnreadable: boolean;
  envUrl: string | null;
  envRepository?: string | null | undefined;
}): { feed: UpdateFeed | null; disabledReason: string | null } {
  if (input.ymlUnreadable)
    return { feed: null, disabledReason: UPDATE_FEED_UNREADABLE };
  if (input.ymlRaw !== null) {
    const manifest = parseUpdateManifest(input.ymlRaw);
    if (!manifest)
      return { feed: null, disabledReason: UPDATE_FEED_UNREADABLE };
    if (manifest.provider === "github") {
      const feed = parseGitHubUpdateFeed(
        `${manifest.owner ?? ""}/${manifest.repo ?? ""}`,
      );
      if (!feed) return { feed: null, disabledReason: UPDATE_FEED_BAD_URL };
      return { feed, disabledReason: null };
    }
    if (manifest.provider !== "generic")
      return { feed: null, disabledReason: UPDATE_FEED_UNSUPPORTED };
    const feedUrl = manifest.url ? normalizeGenericFeedUrl(manifest.url) : null;
    if (!feedUrl) return { feed: null, disabledReason: UPDATE_FEED_BAD_URL };
    return {
      feed: {
        provider: "generic",
        url: feedUrl,
        useMultipleRangeRequest: false,
      },
      disabledReason: null,
    };
  }
  if (input.envRepository?.trim()) {
    const feed = parseGitHubUpdateFeed(input.envRepository.trim());
    return { feed, disabledReason: feed ? null : UPDATE_FEED_BAD_URL };
  }
  const envUrl = input.envUrl?.trim() ?? "";
  if (!envUrl) return { feed: null, disabledReason: UPDATE_FEED_MISSING };
  const feedUrl = normalizeGenericFeedUrl(envUrl);
  if (!feedUrl) return { feed: null, disabledReason: UPDATE_FEED_BAD_URL };
  return {
    feed: { provider: "generic", url: feedUrl, useMultipleRangeRequest: false },
    disabledReason: null,
  };
}

function stripQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  )
    return value.slice(1, -1);
  return value;
}

function readText(path: string) {
  try {
    return { text: readFileSync(path, "utf8"), unreadable: false };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { text: null, unreadable: false };
    return { text: null, unreadable: true };
  }
}
