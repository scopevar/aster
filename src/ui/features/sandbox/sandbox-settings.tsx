import { Button, Input } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import {
  sandboxNetworkConfigurationSchema,
  type SandboxNetworkConfiguration,
  type SandboxSettingsRequest,
  type SandboxSettingsStatus,
} from "../../../shared/tools/sandbox-settings.js";
import { scriptHostnameSchema } from "../../../shared/tools/scripts.js";
import { SettingsSelect } from "../../components/settings/settings-controls.js";
import { desktop, errorMessage } from "../../lib/client.js";
import { toast } from "../../components/toast.js";
import "./sandbox-settings.css";

function draftOf(configuration: SandboxNetworkConfiguration) {
  return {
    dns: configuration.dns.mode,
    servers:
      configuration.dns.mode === "custom"
        ? configuration.dns.servers.join(", ")
        : "",
    protocol: configuration.proxy?.protocol ?? "none",
    address: configuration.proxy?.address ?? "",
  };
}

export function SandboxSettings() {
  const [state, setState] = useState<SandboxSettingsStatus | null>(null);
  const [draft, setDraft] = useState<ReturnType<typeof draftOf> | null>(null);
  const [hostname, setHostname] = useState("wttr.in");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true),
    acting = useRef(false),
    generation = useRef(0),
    ownTest = useRef<string | null>(null);
  useEffect(() => {
    alive.current = true;
    let loading = false;
    const load = async () => {
      if (loading || acting.current) return;
      loading = true;
      const current = generation.current;
      try {
        const next = await desktop.sandboxSettings({ action: "status" });
        if (alive.current && current === generation.current) {
          setState(next);
          setDraft((value) => value ?? draftOf(next.configuration));
        }
      } catch (e) {
        if (alive.current && current === generation.current)
          setError(errorMessage(e));
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      alive.current = false;
      clearInterval(timer);
      if (ownTest.current)
        void desktop
          .sandboxSettings({ action: "cancel", id: ownTest.current })
          .catch((e) => toast.danger(errorMessage(e), { timeout: 5000 }));
    };
  }, []);
  async function act(request: SandboxSettingsRequest, refresh = false) {
    if (acting.current) return;
    acting.current = true;
    generation.current++;
    setBusy(true);
    setError("");
    try {
      const next = await desktop.sandboxSettings(request);
      if (!alive.current) return;
      setState(next);
      if (refresh) setDraft(draftOf(next.configuration));
      if (next.notice) toast.success(next.notice, { timeout: 5000 });
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const configuration = sandboxNetworkConfigurationSchema.safeParse(
    draft && {
      dns:
        draft.dns === "custom"
          ? {
              mode: "custom",
              servers: draft.servers.split(/[,，\s]+/).filter(Boolean),
            }
          : { mode: draft.dns },
      proxy:
        draft.protocol === "none"
          ? null
          : { protocol: draft.protocol, address: draft.address },
    },
  );
  const target = scriptHostnameSchema.safeParse(hostname.trim());
  const disabled = !state?.enabled || !draft || busy;
  const running = state?.test?.state === "running";
  const edit = (patch: Partial<NonNullable<typeof draft>>) => {
    setDraft((current) => current && { ...current, ...patch });
  };
  return (
    <div className="sandbox-settings" aria-busy={busy}>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {state && !state.enabled && (
        <p role="status">此设备仅为控制端，请在执行机器上配置沙箱。</p>
      )}
      <section className="settings-section" aria-label="沙箱资源">
        <h2>脚本资源</h2>
        <div className="setting-group">
          <div className="setting-row">
            <div>
              <span>
                {state?.resources.state === "ready"
                  ? "已就绪"
                  : state?.resources.state === "preparing"
                    ? "正在准备"
                    : "尚未就绪"}
              </span>
              <small>{state?.resources.detail ?? "正在读取本机状态…"}</small>
            </div>
            <Button
              variant="secondary"
              size="sm"
              isDisabled={disabled || state?.resources.state !== "unprepared"}
              onPress={() => void act({ action: "prepare" })}
            >
              准备资源
            </Button>
          </div>
        </div>
      </section>
      <section className="settings-section" aria-label="沙箱网络配置">
        <h2>网络</h2>
        <div className="setting-group">
          <div className="setting-row">
            <div>
              <span>DNS 解析</span>
              <small>
                自动解析通过加密 DNS 获取公网地址，兼容 Fake-IP 代理。
              </small>
            </div>
            <SettingsSelect
              label="DNS 解析"
              value={draft?.dns ?? "auto"}
              disabled={disabled}
              onChange={(dns) =>
                edit({
                  dns: dns === "system" || dns === "custom" ? dns : "auto",
                })
              }
              options={[
                { value: "auto", label: "自动（推荐）" },
                { value: "system", label: "系统 DNS" },
                { value: "custom", label: "自定义 DNS" },
              ]}
            />
          </div>
          {draft?.dns === "custom" && (
            <label className="sandbox-field">
              <span>DNS 服务器</span>
              <Input
                aria-label="DNS 服务器"
                variant="secondary"
                fullWidth
                value={draft.servers}
                disabled={disabled}
                placeholder="1.1.1.1:53, 1.0.0.1:53"
                onChange={(e) => edit({ servers: e.target.value })}
              />
              <small>填写 IP:端口，最多三个，以逗号分隔。</small>
            </label>
          )}
          <div className="setting-row">
            <div>
              <span>出站代理</span>
              <small>使用本机代理监听地址；加密 DNS 同时通过此代理。</small>
            </div>
            <SettingsSelect
              label="出站代理"
              value={draft?.protocol ?? "none"}
              disabled={disabled}
              onChange={(protocol) => edit({ protocol })}
              options={[
                { value: "none", label: "不使用显式代理" },
                { value: "http", label: "HTTP CONNECT" },
                { value: "socks5", label: "SOCKS5" },
              ]}
            />
          </div>
          {draft && draft.protocol !== "none" && (
            <label className="sandbox-field">
              <span>代理地址</span>
              <Input
                aria-label="代理地址"
                variant="secondary"
                fullWidth
                value={draft.address}
                disabled={disabled}
                placeholder="127.0.0.1:7897"
                onChange={(e) => edit({ address: e.target.value })}
              />
              <small>填写 IP:端口，支持无需认证的代理。</small>
            </label>
          )}
        </div>
        {!configuration.success && draft && (
          <p className="error" role="alert">
            {configuration.error.issues[0]?.message}
          </p>
        )}
        <div className="sandbox-actions">
          <Button
            variant="secondary"
            size="sm"
            isDisabled={busy}
            onPress={() => void act({ action: "status" }, true)}
          >
            重新读取
          </Button>
          <Button
            variant="primary"
            size="sm"
            isDisabled={disabled || !configuration.success}
            onPress={() => {
              if (state && configuration.success)
                void act({
                  action: "save",
                  revision: state.revision,
                  configuration: configuration.data,
                });
            }}
          >
            保存配置
          </Button>
        </div>
      </section>
      <section className="settings-section" aria-label="沙箱连接诊断">
        <h2>检查连接</h2>
        <div className="setting-group">
          <label className="sandbox-field">
            <span>测试域名</span>
            <Input
              aria-label="测试域名"
              variant="secondary"
              fullWidth
              value={hostname}
              disabled={disabled || running}
              onChange={(e) => setHostname(e.target.value)}
            />
            {!target.success && (
              <small className="error">请输入有效的公网域名。</small>
            )}
          </label>
          <div className="setting-row">
            <div>
              <span>在独立沙箱中检查</span>
              <small>使用上方配置访问该域名的 HTTPS 首页。</small>
            </div>
            {running && state.test ? (
              <Button
                variant="secondary"
                size="sm"
                isDisabled={busy}
                onPress={() => {
                  if (state.test)
                    void act({ action: "cancel", id: state.test.id });
                }}
              >
                停止检查
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                isDisabled={
                  disabled || !configuration.success || !target.success
                }
                onPress={() => {
                  if (!configuration.success || !target.success) return;
                  const id = crypto.randomUUID();
                  ownTest.current = id;
                  void act({
                    action: "test",
                    id,
                    hostname: target.data,
                    configuration: configuration.data,
                  });
                }}
              >
                检查连接
              </Button>
            )}
          </div>
          {state?.test && (
            <div className="sandbox-result" role="status">
              <strong>
                {state.test.hostname} ·{" "}
                {
                  {
                    running: "检查中",
                    passed: "连接正常",
                    failed: "连接失败",
                    cancelled: "已停止",
                  }[state.test.state]
                }
              </strong>
              <p>{state.test.detail}</p>
              <p>
                系统 DNS：
                {state.test.systemAddresses.join(", ") || "未能取得解析结果"}
              </p>
              <p>沙箱 DNS：{state.test.dns.detail}</p>
              <p>沙箱 HTTPS：{state.test.https.detail}</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
