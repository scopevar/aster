import { IconButton } from "../../components/icon-button.js";
import { Button } from "@heroui/react";
import {
  SettingsSearch,
  SettingsSwitch,
} from "../../components/settings/settings-controls.js";
import { useEffect, useRef, useState } from "react";
import {
  agentConnectionsConfigSchema,
  agentConnectionsStatusSchema,
  type AgentConnection,
  type AgentConnectionsConfig,
  type AgentConnectionsRequest,
  type AgentConnectionsStatus,
} from "../../../shared/agent-connections.js";
import { desktop, errorMessage } from "../../lib/client.js";
import { ConnectionEditor } from "./connection-editor.js";
import { AddConnectionDialog } from "./add-connection-dialog.js";
import { Icon } from "../../components/icons.js";
import { ProviderPicker } from "./provider-picker.js";
import { toast } from "../../components/toast.js";
import {
  providerDraft,
  providerPresets,
  type ProviderPreset,
} from "./provider-presets.js";
import "./model-connections.css";
import {
  useSettingsData,
  useSettingsMutation,
} from "../settings/settings-data.js";
import {
  SettingsLoading,
  SettingsReadError,
} from "../../components/settings/settings-loading.js";
import { useSettingsSection } from "../settings/settings-section.js";
import { JevSettings } from "./jev-settings.js";

export function ModelConnections() {
  const [status, setStatus, readStatus] = useSettingsData("connections");
  const { page, navigate, error, setError, back } = useSettingsSection();
  const screen = page.screen;
  const editor = page.screen === "editor" ? page.editor : null;
  const adding =
    screen === "picker" || (screen === "editor" && editor?.originalId === null);
  const addButton = useRef<HTMLButtonElement>(null);
  const wasAdding = useRef(false);
  const { busy: operations, run: mutate } = useSettingsMutation();
  const busy = operations.has("connections");
  const [query, setQuery] = useState("");
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const toggleIds = useRef(new Set<string>());
  const toggleQueue = useRef(Promise.resolve());
  const latest = useRef<AgentConnectionsStatus | null>(status);
  const view = useRef<HTMLDivElement>(null);
  const alive = useRef(false),
    pending = useRef(false);
  const request = async (input: AgentConnectionsRequest): Promise<boolean> => {
    if (pending.current) return false;
    pending.current = true;
    setError("");
    let succeeded = false;
    await mutate("connections", async () => {
      try {
        const next = agentConnectionsStatusSchema.parse(
          await desktop.agentConnections(input),
        );
        if (alive.current && input.action !== "status" && next.notice)
          toast.success(
            input.action === "save"
              ? "已保存，下一次运行生效"
              : input.action === "check"
                ? "配置检查通过，未向模型发出请求"
                : "真实推理测试通过",
            { timeout: 5000 },
          );
        // Checks must not grant an old draft a newer file revision.
        const current = latest.current;
        const updated =
          (input.action === "check" ||
            input.action === "test" ||
            input.action === "jev.test") &&
          current
            ? {
                ...current,
                notice: next.notice,
                active: next.active,
                override: next.override,
              }
            : next;
        latest.current = updated;
        setStatus(updated);
        succeeded = alive.current;
      } catch (failure) {
        if (alive.current) setError(errorMessage(failure));
        else toast.danger(errorMessage(failure), { timeout: 5000 });
      } finally {
        pending.current = false;
      }
    });
    return succeeded;
  };
  const load = () => {
    setError("");
    void readStatus(async () =>
      agentConnectionsStatusSchema.parse(
        await desktop.agentConnections({ action: "status" }),
      ),
    ).catch((failure: unknown) => {
      if (alive.current) setError(errorMessage(failure));
    });
  };
  useEffect(() => {
    alive.current = true;
    if (!status) load();
    return () => {
      alive.current = false;
    };
  }, [readStatus]);
  useEffect(() => {
    latest.current = status;
  }, [status]);
  useEffect(() => {
    if (screen === "editor" && !adding)
      view.current?.focus({ preventScroll: true });
    if (wasAdding.current && !adding)
      addButton.current?.focus({ preventScroll: true });
    wasAdding.current = adding;
  }, [screen, adding]);
  const save = async (
    config: AgentConnectionsConfig,
    credential?: { provider: string; key: string },
  ) => {
    if (!status) return;
    const parsed = agentConnectionsConfigSchema.safeParse(config);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "连接配置无效。");
      return;
    }
    if (
      await request({
        action: "save",
        revision: status.revision,
        config: parsed.data,
        ...(credential ? { credential } : {}),
      })
    ) {
      navigate({ screen: "list" });
    }
  };
  const toggle = (id: string) => {
    if (toggleIds.current.has(id)) return;
    toggleIds.current.add(id);
    setToggling(new Set(toggleIds.current));
    // Each queued row change uses the revision committed by the preceding change.
    toggleQueue.current = toggleQueue.current
      .then(async () => {
        const current = latest.current;
        if (!alive.current || !current) return;
        await request({
          action: "save",
          revision: current.revision,
          config: {
            ...current.config,
            connections: current.config.connections.map((entry) =>
              entry.id === id ? { ...entry, enabled: !entry.enabled } : entry,
            ),
          },
        });
      })
      .catch((failure: unknown) => {
        if (alive.current) setError(errorMessage(failure));
      })
      .finally(() => {
        toggleIds.current.delete(id);
        if (alive.current) setToggling(new Set(toggleIds.current));
      });
  };
  const choose = (preset: ProviderPreset | null) => {
    if (!status) return;
    navigate({
      screen: "editor",
      editor: {
        originalId: null,
        connection: providerDraft(preset, status.config.connections),
        preset,
      },
    });
    setError("");
  };
  const update = (connection: AgentConnection, apiKey?: string) => {
    if (!status || !editor) return;
    const { config } = status;
    void save(
      {
        ...config,
        botConnections:
          config.botConnections &&
          Object.fromEntries(
            Object.entries(config.botConnections).map(([botId, id]) => [
              botId,
              id === editor.originalId ? connection.id : id,
            ]),
          ),
        defaultAgent:
          !config.connections.length ||
          config.defaultAgent === editor.originalId
            ? connection.id
            : config.defaultAgent,
        connections:
          editor.originalId === null
            ? [...config.connections, connection]
            : config.connections.map((entry) =>
                entry.id === editor.originalId ? connection : entry,
              ),
      },
      apiKey ? { provider: connection.provider, key: apiKey } : undefined,
    );
  };
  const remove = () => {
    if (!status || !editor?.originalId) return;
    const connections = status.config.connections.filter(
      (entry) => entry.id !== editor.originalId,
    );
    void save({
      ...status.config,
      connections,
      defaultAgent:
        status.config.defaultAgent === editor.originalId
          ? (connections[0]?.id ?? "")
          : status.config.defaultAgent,
    });
  };
  const connections = status?.config.connections ?? [];
  const search = query.trim().toLocaleLowerCase();
  const visible = connections.filter((entry) =>
    `${entry.id} ${entry.provider} ${entry.model} ${entry.baseUrl}`
      .toLocaleLowerCase()
      .includes(search),
  );
  const editorView = screen === "editor" && editor && (
    <ConnectionEditor
      key={`${editor.originalId ?? "new"}:${editor.connection.id}`}
      connection={editor.connection}
      preset={editor.preset}
      isNew={editor.originalId === null}
      busy={busy}
      serverError={error}
      storedProviders={status?.storedProviders ?? []}
      onSave={update}
      onCheck={(connection, apiKey) => {
        void request({
          action: "check",
          connection,
          ...(apiKey ? { apiKey } : {}),
        });
      }}
      onTest={(connection, apiKey) => {
        void request({
          action: "test",
          connection,
          ...(apiKey ? { apiKey } : {}),
        });
      }}
      onDelete={remove}
      onCancel={back}
    />
  );
  return (
    <div
      ref={view}
      tabIndex={-1}
      className="model-connections"
      aria-label="模型与连接配置"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing &&
          screen !== "list" &&
          !(
            event.target instanceof Element &&
            event.target.closest('select:open, dialog[open], [role="dialog"]')
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          back();
        }
      }}
    >
      {error && status && screen !== "editor" && !adding && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status?.override && <p className="settings-note">{status.override}</p>}
      {!status && !error && <SettingsLoading label="正在读取供应商…" />}
      {!status && error && <SettingsReadError error={error} onRetry={load} />}
      {(screen === "list" || adding) &&
        status &&
        (connections.length === 0 ? (
          <div className="provider-empty">
            <span className="provider-empty-icon">
              <Icon name="link" size={26} />
            </span>
            <h3>连接你的模型</h3>
            <p>添加云端服务或本地模型，为 Bot 选择可用的连接。</p>
            <Button
              variant="primary"
              className="model-add-connection"
              ref={addButton}
              onPress={() => navigate({ screen: "picker" })}
              isDisabled={busy}
            >
              <Icon name="plus" size={15} />
              添加连接
            </Button>
          </div>
        ) : (
          <>
            <div className="provider-list-toolbar">
              <SettingsSearch
                label="搜索已添加供应商"
                placeholder="查找供应商"
                value={query}
                onChange={setQuery}
                className="settings-provider-search"
              />
              <Button
                variant="primary"
                className="model-add-connection"
                ref={addButton}
                isDisabled={
                  (busy && toggling.size === 0) || connections.length >= 64
                }
                onPress={() => {
                  void toggleQueue.current.then(() => {
                    if (!alive.current) return;
                    navigate({ screen: "picker" });
                    setError("");
                  });
                }}
              >
                <Icon name="plus" size={16} />
                添加连接
              </Button>
            </div>
            <div className="provider-list" role="group" aria-label="可用连接">
              {visible.map((entry) => {
                const preset =
                  providerPresets.find((item) => item.id === entry.provider) ??
                  null;
                return (
                  <article className="provider-card" key={entry.id}>
                    <span
                      className="provider-mark"
                      data-provider={entry.provider}
                    >
                      <Icon
                        name={entry.provider === "local" ? "computer" : "globe"}
                        size={21}
                      />
                    </span>
                    <div className="provider-card-info">
                      <strong>{entry.id}</strong>
                      <small
                        title={[entry.model, entry.baseUrl]
                          .filter(Boolean)
                          .join(" · ")}
                      >
                        {entry.model}
                        {entry.baseUrl && (
                          <> · {new URL(entry.baseUrl).hostname}</>
                        )}
                      </small>
                    </div>
                    <div className="provider-card-actions">
                      <span
                        className="provider-availability"
                        data-enabled={entry.enabled}
                        title={entry.enabled ? "可用于 Bot" : "已停用"}
                      >
                        <span className="provider-dot" />
                        {preset?.name ?? entry.provider}
                      </span>
                      <SettingsSwitch
                        label={`启用 ${entry.id}`}
                        selected={entry.enabled}
                        disabled={busy && toggling.size === 0}
                        busy={toggling.has(entry.id)}
                        onChange={() => toggle(entry.id)}
                      />
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label={`编辑 ${entry.id}`}
                        isDisabled={busy && toggling.size === 0}
                        onPress={() => {
                          void toggleQueue.current.then(() => {
                            if (!alive.current) return;
                            const current =
                              latest.current?.config.connections.find(
                                (item) => item.id === entry.id,
                              );
                            if (!current) return;
                            navigate({
                              screen: "editor",
                              editor: {
                                originalId: entry.id,
                                connection: current,
                                preset,
                              },
                            });
                            setError("");
                          });
                        }}
                      >
                        <Icon name="chevron" size={14} />
                      </IconButton>
                    </div>
                  </article>
                );
              })}
            </div>
            {visible.length === 0 && (
              <p className="provider-no-results">没有匹配的供应商</p>
            )}
          </>
        ))}
      {screen === "list" && status && (
        <JevSettings status={status} busy={busy} request={request} />
      )}
      {!adding && editorView}
      {adding && (
        <AddConnectionDialog
          choosing={screen === "picker"}
          busy={busy}
          onClose={back}
        >
          {screen === "picker" ? (
            <ProviderPicker onSelect={choose} />
          ) : (
            editorView
          )}
        </AddConnectionDialog>
      )}
    </div>
  );
}
