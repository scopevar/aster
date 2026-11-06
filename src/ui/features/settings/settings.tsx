import { Button } from "@heroui/react";
import {
  SettingsSelect,
  SettingsSwitch,
} from "../../components/settings/settings-controls.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CommandResult } from "../../../shared/core.js";
import {
  localProjectId,
  type SharedMemoryScope,
} from "../../../shared/memory.js";
import type {
  DesktopPreferences,
  PreferencesChange,
} from "../../../shared/desktop/preferences.js";
import { themeSchema } from "../../../shared/desktop/preferences.js";
import { errorMessage } from "../../lib/client.js";
import { SettingsPage } from "./settings-page.js";
import { SharedMemoryManager } from "../memory/shared-memory.js";
import type { DesktopEnvelope } from "../../../shared/desktop/desktop-commands.js";
import { ShortcutSettings } from "./shortcut-settings.js";
import { ModelConnections } from "../connections/model-connections.js";
import { AppUpdateSettings } from "./settings-updates.js";
import { ApplicationInfo } from "./application-info.js";
import { SandboxSettings } from "../sandbox/sandbox-settings.js";
import { BackupSettings } from "./settings-backup.js";
import { ConversationSettings } from "./conversation-settings.js";
import { toast } from "../../components/toast.js";
import { Icon } from "../../components/icons.js";

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-label={title}>
      <h2>{title}</h2>
      <div className="setting-group">{children}</div>
    </section>
  );
}
function Row({
  label,
  children,
  description,
}: {
  label: string;
  children: ReactNode;
  description?: string | undefined;
}) {
  return (
    <div className="setting-row">
      <div>
        <span>{label}</span>
        {description && <small>{description}</small>}
      </div>
      {children}
    </div>
  );
}
function Unavailable({ children }: { children: ReactNode }) {
  return <span className="setting-unavailable">{children}</span>;
}

export function Settings({
  tab,
  onTab,
  onClose,
  preferences,
  onSave,
  submit,
  memoryScope,
  onSharedMemory,
}: {
  tab: string;
  onTab(value: string): void;
  onClose(): void;
  preferences: DesktopPreferences | null;
  onSave(change: PreferencesChange): Promise<void>;
  submit(
    command: Command,
    request?: DesktopEnvelope,
  ): Promise<CommandResult | undefined>;
  memoryScope: SharedMemoryScope | null;
  onSharedMemory(scope: SharedMemoryScope | null): void;
}) {
  const [pendingFields, setPendingFields] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const themeChoice = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const select = themeChoice.current;
    if (!select) return;
    const reveal = () => {
      const rect = select.getBoundingClientRect();
      const clipped =
        rect.top < 0 ||
        rect.left < 0 ||
        rect.bottom > window.innerHeight ||
        rect.right > window.innerWidth;
      const intersects =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
      if (clipped && intersects)
        select.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    reveal();
    window.addEventListener("resize", reveal);
    return () => window.removeEventListener("resize", reveal);
  }, [tab, preferences]);
  const change = async (patch: Omit<PreferencesChange, "revision">) => {
    const fields = Object.keys(patch);
    if (!preferences || fields.some((field) => pendingFields.has(field)))
      return;
    setPendingFields((current) => new Set([...current, ...fields]));
    setError("");
    try {
      await onSave({ revision: preferences.revision, ...patch });
      if (patch.hardwareAcceleration !== undefined)
        toast.success(
          patch.hardwareAcceleration === preferences.appliedHardwareAcceleration
            ? "已保存，当前界面已使用此设置"
            : "已保存，下次启动界面时生效",
          { timeout: 5000 },
        );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPendingFields(
        (current) =>
          new Set([...current].filter((field) => !fields.includes(field))),
      );
    }
  };
  return (
    <SettingsPage
      tab={tab}
      onTab={onTab}
      onClose={onClose}
      detail={
        tab === "共享记忆" && memoryScope
          ? {
              title: memoryScope.kind === "account" ? "本地记忆" : "项目记忆",
              backLabel: "返回记忆范围",
              disabled: false,
              onBack: () => onSharedMemory(null),
            }
          : null
      }
    >
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {tab === "通用" ? (
        <>
          <Group title="外观">
            <Row label="主题">
              <SettingsSelect
                triggerRef={themeChoice}
                className="settings-theme-select"
                label="主题"
                value={preferences?.theme ?? "system"}
                disabled={!preferences || pendingFields.has("theme")}
                onChange={(selection) => {
                  void change({
                    theme: themeSchema.parse(selection),
                  });
                }}
                options={[
                  { value: "system", label: "跟随系统" },
                  { value: "light", label: "浅色" },
                  { value: "dark", label: "深色" },
                ]}
              />
            </Row>
            <Row label="语言">
              <Unavailable>简体中文</Unavailable>
            </Row>
          </Group>
          <ConversationSettings />
          <Group title="系统">
            <Row label="使用硬件加速">
              <SettingsSwitch
                label="使用硬件加速"
                selected={preferences?.hardwareAcceleration ?? false}
                disabled={!preferences}
                busy={pendingFields.has("hardwareAcceleration")}
                onChange={() => {
                  void change({
                    hardwareAcceleration: !preferences?.hardwareAcceleration,
                  });
                }}
              />
            </Row>
          </Group>
        </>
      ) : tab === "数据与备份" ? (
        <BackupSettings />
      ) : tab === "沙箱" ? (
        <SandboxSettings />
      ) : tab === "快捷键" ? (
        <Group title="全局快捷键">
          <ShortcutSettings preferences={preferences} onSave={onSave} />
        </Group>
      ) : tab === "共享记忆" ? (
        memoryScope ? (
          <SharedMemoryManager
            key={memoryScope.kind}
            scope={memoryScope}
            act={submit}
            onClose={() => onSharedMemory(null)}
          />
        ) : (
          <Group title="记忆范围">
            <Button
              variant="ghost"
              type="button"
              className="setting-row settings-navigation-row"
              aria-label="管理本地记忆"
              onPress={() => onSharedMemory({ kind: "account" })}
            >
              <span>
                <span>本地记忆</span>
                <small>所有 Bot 共用的偏好与信息</small>
              </span>
              <Icon name="chevron" size={16} />
            </Button>
            <Button
              variant="ghost"
              type="button"
              className="setting-row settings-navigation-row"
              aria-label="管理项目记忆"
              onPress={() =>
                onSharedMemory({ kind: "project", projectId: localProjectId })
              }
            >
              <span>
                <span>项目记忆</span>
                <small>仅用于当前本地项目</small>
              </span>
              <Icon name="chevron" size={16} />
            </Button>
          </Group>
        )
      ) : tab === "模型与连接" ? (
        <ModelConnections />
      ) : tab === "应用信息" ? (
        <ApplicationInfo />
      ) : (
        <div className="settings-updates">
          <AppUpdateSettings
            preferences={preferences}
            pendingChannel={pendingFields.has("updateChannel")}
            pendingAutoUpdate={pendingFields.has("autoUpdate")}
            onSave={change}
          />
        </div>
      )}
    </SettingsPage>
  );
}
