import { Checkbox } from "../../components/checkbox.js";
import { Icon } from "../../components/icons.js";
import { IconButton } from "../../components/icon-button.js";
import { Button, Input, Spinner } from "@heroui/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  pluginsResponseSchema,
  type PluginPreview,
  type PluginsRequest,
  type PluginsResponse,
} from "../../../shared/tools/plugins.js";
import { desktop, errorMessage } from "../../lib/client.js";
import "./plugins.css";
import { PluginHelp } from "./plugin-help.js";
import { PluginAccounts } from "./plugin-accounts.js";

export function PluginManager({
  botId,
  onChanged,
  query = "",
  target,
}: {
  botId: string | null;
  onChanged(): void;
  query?: string;
  target?: ReactNode;
}) {
  const [view, setView] = useState<PluginsResponse>({
    plugins: [],
    preview: null,
    notice: "",
  });
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!!botId);
  const [refreshing, setRefreshing] = useState(false);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [enableTools, setEnableTools] = useState(false),
    [editing, setEditing] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const current = useRef(botId),
    alive = useRef(true),
    locked = useRef(false);
  current.current = botId;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setView({ plugins: [], preview: null, notice: "" });
    setError("");
    setEditing(null);
    setVariables({});
    setLoading(!!botId);
    const version = ++requestVersion.current;
    let active = true;
    if (botId)
      void desktop
        .plugins({ action: "list", botId })
        .then((value) => {
          if (active && version === requestVersion.current)
            setView(pluginsResponseSchema.parse(value));
        })
        .catch((failure) => {
          if (active && version === requestVersion.current)
            setError(errorMessage(failure));
        })
        .finally(() => {
          if (active && version === requestVersion.current) setLoading(false);
        });
    return () => {
      active = false;
    };
  }, [botId]);
  const run = async (request: PluginsRequest) => {
    if (locked.current) return;
    const version = ++requestVersion.current;
    const reading = request.action === "list";
    // Reading keeps the current content and mutation controls stable. A mutation
    // can supersede the read through the existing request version check.
    if (reading) setRefreshing(true);
    else {
      locked.current = true;
      setBusy(true);
    }
    setError("");
    try {
      const value = pluginsResponseSchema.parse(await desktop.plugins(request));
      if (
        !alive.current ||
        current.current !== request.botId ||
        version !== requestVersion.current
      )
        return;
      setView(value);
      if (request.action === "prepare") {
        setVariables({});
        setEnableTools(false);
        setEditing(null);
      }
      if (["install", "remove"].includes(request.action)) onChanged();
      if (request.action === "configure") {
        setEditing(null);
        setVariables({});
      }
    } catch (failure) {
      if (
        alive.current &&
        current.current === request.botId &&
        version === requestVersion.current
      )
        setError(errorMessage(failure));
    } finally {
      if (!reading) locked.current = false;
      if (alive.current) {
        if (reading) setRefreshing(false);
        else setBusy(false);
      }
    }
  };
  const fields = (names: string[]) =>
    names.map((name) => {
      const label = name;
      return (
        <label key={name}>
          {label}
          <Input
            variant="secondary"
            fullWidth
            aria-label={label}
            type="password"
            autoComplete="off"
            value={variables[name] ?? ""}
            onChange={(event) =>
              setVariables({ ...variables, [name]: event.target.value })
            }
          />
        </label>
      );
    });
  const summary = (
    preview: Pick<PluginPreview, "skills" | "servers" | "warnings">,
  ) => (
    <>
      <p>
        {preview.skills.length} 个技能 · {preview.servers.length} 个 MCP 服务
      </p>
      {preview.skills.length > 0 && (
        <ul>
          {preview.skills.map((skill) => (
            <li key={skill.name}>
              {skill.name} — {skill.description}
            </li>
          ))}
        </ul>
      )}
      {preview.servers.length > 0 && (
        <ul>
          {preview.servers.map((server) => (
            <li key={server.name}>
              {server.name}（{server.transport}）：<code>{server.target}</code>
            </li>
          ))}
        </ul>
      )}
      {preview.warnings.map((warning) => (
        <p className="plugin-warning" key={warning}>
          {warning}
        </p>
      ))}
    </>
  );
  const search = query.trim().toLocaleLowerCase();
  const displayedPlugins = view.plugins.filter((plugin) =>
    [plugin.name, plugin.description].some((text) =>
      text.toLocaleLowerCase().includes(search),
    ),
  );
  return (
    <section className="plugin-manager" aria-label="本地插件管理">
      <div className="plugin-manager-heading">
        {target ?? (
          <div>
            <div className="plugin-manager-title">
              <h3>已安装插件</h3>
              <PluginHelp />
            </div>
          </div>
        )}
        <div className="plugin-manager-actions">
          {botId && (
            <Button
              variant="secondary"
              size="sm"
              isDisabled={busy || loading}
              onPress={() => {
                void run({ action: "prepare", botId });
              }}
            >
              <Icon name="plus" size={16} />
              导入本地插件
            </Button>
          )}
          {botId && (
            <IconButton
              aria-label="刷新插件列表"
              aria-busy={refreshing}
              isDisabled={busy || loading || refreshing}
              onPress={() => {
                void run({ action: "list", botId });
              }}
            >
              {refreshing ? (
                <Spinner size="sm" />
              ) : (
                <Icon name="refresh" size={16} />
              )}
            </IconButton>
          )}
        </div>
      </div>
      {!botId && (
        <p className="plugin-manager-empty">
          <Icon name="bot" size={22} />
          先选择一个 Bot。
        </p>
      )}
      {loading && (
        <p
          className="plugin-manager-empty"
          role="status"
          aria-label="正在读取插件"
        >
          <Icon name="skill" size={22} />
          正在读取插件…
        </p>
      )}
      {view.preview && botId && (
        <article className="plugin-panel">
          <h4>
            导入预览：{view.preview.name} {view.preview.version}
          </h4>
          <p>{view.preview.description}</p>
          {summary(view.preview)}
          {fields(view.preview.variables)}
          {view.preview.servers.length > 0 && (
            <Checkbox
              className="plugin-check"
              isSelected={enableTools}
              isDisabled={busy}
              onChange={setEnableTools}
            >
              启用 MCP（允许启动本机程序或连接上述地址；每次工具调用另行审批）
            </Checkbox>
          )}
          <Button
            variant="primary"
            isDisabled={busy}
            onPress={() => {
              if (view.preview)
                void run({
                  action: "install",
                  botId,
                  id: view.preview.id,
                  epoch: view.preview.epoch,
                  variables,
                  enableTools,
                });
            }}
          >
            确认导入
          </Button>
          <Button
            variant="secondary"
            isDisabled={busy}
            onPress={() => setView({ ...view, preview: null })}
          >
            取消
          </Button>
        </article>
      )}
      {botId &&
        !loading &&
        view.plugins.length === 0 &&
        !view.preview &&
        !error && (
          <div className="plugin-manager-empty">
            <Icon name="skill" size={24} />
            <strong>该 Bot 尚未安装插件。</strong>
            <p>导入本地插件，为助手添加技能与工具。</p>
          </div>
        )}
      {!loading &&
        !error &&
        view.plugins.length > 0 &&
        displayedPlugins.length === 0 && (
          <p className="plugin-manager-empty" role="status">
            没有匹配的插件
          </p>
        )}
      {displayedPlugins.map((plugin) => (
        <article className="plugin-panel" key={plugin.id}>
          <h4>
            {plugin.name}{" "}
            <small>
              {plugin.format} · {plugin.version || "未标版本"}
            </small>
          </h4>
          <p>{plugin.description}</p>
          {summary(plugin)}
          <p>MCP：{plugin.enabled ? "已启用" : "已关闭"}</p>
          {botId && (
            <PluginAccounts botId={botId} plugin={plugin} disabled={busy} />
          )}
          {botId && (
            <>
              {plugin.servers.length > 0 && (
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => {
                    void run({
                      action: "configure",
                      botId,
                      id: plugin.id,
                      enabled: !plugin.enabled,
                    });
                  }}
                >
                  {plugin.enabled ? "关闭 MCP" : "启用 MCP"}
                </Button>
              )}
              {plugin.variables.length > 0 && (
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => {
                    setEditing(editing === plugin.id ? null : plugin.id);
                    setVariables({});
                  }}
                >
                  重新配置变量
                </Button>
              )}
              {editing === plugin.id && (
                <div>
                  {fields(plugin.variables)}
                  <p>保存会替换该插件的全部变量；请重新填写令牌。</p>
                  <Button
                    variant="secondary"
                    isDisabled={busy}
                    onPress={() => {
                      void run({
                        action: "configure",
                        botId,
                        id: plugin.id,
                        enabled: plugin.enabled,
                        variables,
                      });
                    }}
                  >
                    保存变量
                  </Button>
                </div>
              )}
              <Button
                variant="danger"
                isDisabled={busy}
                onPress={() => {
                  void run({ action: "remove", botId, id: plugin.id });
                }}
              >
                卸载
              </Button>
            </>
          )}
        </article>
      ))}
      {view.notice && <p role="status">{view.notice}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
