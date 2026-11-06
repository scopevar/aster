import { Button } from "@heroui/react";
import {
  SettingsSelect,
  SettingsSwitch,
} from "../../components/settings/settings-controls.js";
import { useEffect, useState } from "react";
import {
  UPDATE_FEED_MISSING,
  type AppUpdateState,
} from "../../../shared/desktop/app-update.js";
import type {
  DesktopPreferences,
  PreferencesChange,
} from "../../../shared/desktop/preferences.js";
import { appUpdate, errorMessage } from "../../lib/client.js";
import { useSettingsData, useSettingsMutation } from "./settings-data.js";
import {
  SettingsLoading,
  SettingsReadError,
} from "../../components/settings/settings-loading.js";

export function AppUpdateSettings({
  preferences,
  pendingChannel,
  pendingAutoUpdate,
  onSave,
}: {
  preferences: DesktopPreferences | null;
  pendingChannel: boolean;
  pendingAutoUpdate: boolean;
  onSave(change: Omit<PreferencesChange, "revision">): Promise<void>;
}) {
  const [state, setState, readState] = useSettingsData("updates");
  const { busy: operations, run: mutate } = useSettingsMutation();
  const busy = operations.has("updates");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    if (!state)
      void readState(() => appUpdate({ action: "state" })).catch(
        (cause: unknown) => {
          if (live) setError(errorMessage(cause));
        },
      );
    return () => {
      live = false;
    };
  }, [readState]);
  const legacy = state === null || state.disabledReason === UPDATE_FEED_MISSING;
  const enabled = state !== null && state.enabled;
  const run = async (action: "check" | "download" | "install") => {
    setError("");
    await mutate("updates", async () => {
      try {
        setState(await appUpdate({ action }));
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  };
  const version = state?.currentVersion ?? "0.1.0";
  const auto = enabled && (preferences?.autoUpdate ?? false);
  if (!state)
    return error ? (
      <SettingsReadError
        error={error}
        onRetry={() => {
          setError("");
          void readState(() => appUpdate({ action: "state" })).catch(
            (cause: unknown) => setError(errorMessage(cause)),
          );
        }}
      />
    ) : (
      <SettingsLoading label="正在读取更新状态…" />
    );
  return (
    <section className="settings-section" aria-label="应用更新">
      <h3>应用更新</h3>
      <div className="setting-group">
        <div className="setting-row">
          <div>
            <span>更新通道</span>
            <small>
              {state === null || state.disabledReason === UPDATE_FEED_MISSING
                ? "发布通道尚未配置，当前无法下载或安装更新。"
                : state.enabled
                  ? "稳定版经过确认后发布，Nightly 提供最新测试版本。切换通道不会自动降级。"
                  : (state.disabledReason ?? "更新源尚未配置。")}
            </small>
          </div>
          <SettingsSelect
            label="更新通道"
            disabled={
              !enabled ||
              pendingChannel ||
              busy ||
              state.status === "checking" ||
              state.status === "downloading"
            }
            value={state?.enabled ? state.channel : "unavailable"}
            onChange={(selection) => {
              const value = selection;
              if (value === "latest" || value === "nightly")
                void onSave({ updateChannel: value });
            }}
            options={
              enabled
                ? [
                    { value: "latest", label: "稳定" },
                    { value: "nightly", label: "Nightly" },
                  ]
                : [{ value: "unavailable", label: "未配置" }]
            }
          />
        </div>
        <div className="setting-row">
          <div>
            <span>自动更新</span>
            <small>
              {legacy
                ? "配置更新通道后，才能启用自动更新。"
                : enabled
                  ? "开启后约 15 秒开始检查，之后每 4 分钟检查一次。下载和安装仍需手动确认。"
                  : "当前无法启用自动更新。"}
            </small>
          </div>
          <SettingsSwitch
            label="自动更新"
            selected={auto}
            disabled={!enabled}
            busy={pendingAutoUpdate}
            onChange={() => {
              if (!enabled || pendingAutoUpdate) return;
              void onSave({ autoUpdate: !(preferences?.autoUpdate ?? false) });
            }}
          />
        </div>
        <div className="setting-row">
          <div>
            <span>版本 {version}</span>
            <small>{versionDescription(state, legacy)}</small>
          </div>
          <Button
            variant="secondary"
            isDisabled={
              !enabled ||
              pendingChannel ||
              pendingAutoUpdate ||
              busy ||
              state?.status === "checking" ||
              state?.status === "downloading"
            }
            onPress={() => {
              if (!state?.enabled) return;
              if (state.status === "downloaded") void run("install");
              else if (state.status === "available") void run("download");
              else void run("check");
            }}
          >
            {buttonLabel(state)}
          </Button>
        </div>
        {error && !legacy ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function versionDescription(state: AppUpdateState | null, legacy: boolean) {
  if (legacy || !state) return "尚未检查远端版本。更新通道尚未配置。";
  if (!state.enabled) return state.disabledReason ?? "更新源尚未配置。";
  if (state.status === "checking") return "正在检查更新。";
  if (state.status === "available" && state.availableVersion)
    return `发现 ${state.availableVersion}，可手动下载。`;
  if (state.status === "downloading")
    return `正在下载 ${state.availableVersion ?? "更新"}。`;
  if (state.status === "downloaded" && state.downloadedVersion)
    return `${state.downloadedVersion} 已下载，可安装并重启。`;
  if (state.status === "up-to-date") return "当前已是该通道的最新版本。";
  if (state.status === "error") return state.message ?? "检查更新失败。";
  return "尚未检查远端版本。";
}

function buttonLabel(state: AppUpdateState | null) {
  if (!state?.enabled) return "检查更新";
  if (state.status === "checking") return "检查中…";
  if (state.status === "available") return "下载更新";
  if (state.status === "downloading")
    return `下载中 ${state.downloadPercent ?? 0}%`;
  if (state.status === "downloaded") return "安装并重启";
  return "检查更新";
}
