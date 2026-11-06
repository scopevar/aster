import { Button } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import {
  pluginsResponseSchema,
  type InstalledPlugin,
  type PluginAuthorization,
} from "../../../shared/tools/plugins.js";
import { desktop, errorMessage } from "../../lib/client.js";

type Server = InstalledPlugin["servers"][number];
function PluginAccount({
  botId,
  pluginId,
  server,
  disabled,
}: {
  botId: string;
  pluginId: string;
  server: Server;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<PluginAuthorization | undefined>(
    server.authorization,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    version = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      version.current++;
    };
  }, []);
  useEffect(() => {
    setStatus(server.authorization);
  }, [server.authorization]);
  useEffect(() => {
    if (status?.state !== "pending") return;
    let active = true,
      running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      const revision = version.current;
      void desktop
        .plugins({ action: "list", botId })
        .then((value) => {
          if (!active || revision !== version.current) return;
          const result = pluginsResponseSchema.parse(value);
          setStatus(
            result.plugins
              .find((entry) => entry.id === pluginId)
              ?.servers.find((entry) => entry.name === server.name)
              ?.authorization,
          );
        })
        .catch((failure) => {
          if (active) setError(errorMessage(failure));
        })
        .finally(() => {
          running = false;
        });
    }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [botId, pluginId, server.name, status?.state]);
  const run = async (action: "authorize" | "disconnect") => {
    if (busy) return;
    const revision = ++version.current;
    setBusy(true);
    setError("");
    try {
      const value = pluginsResponseSchema.parse(
        await desktop.plugins({
          action,
          botId,
          id: pluginId,
          server: server.name,
        }),
      );
      if (alive.current && revision === version.current)
        setStatus(
          value.plugins
            .find((entry) => entry.id === pluginId)
            ?.servers.find((entry) => entry.name === server.name)
            ?.authorization,
        );
    } catch (failure) {
      if (alive.current && revision === version.current)
        setError(errorMessage(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  if (!status) return null;
  return (
    <div
      className="plugin-account"
      role="group"
      aria-label={`${server.name} 账号连接`}
    >
      <span>
        {server.name} ·{" "}
        {status.state === "connected"
          ? "账号已连接"
          : status.state === "pending"
            ? "等待浏览器授权"
            : "账号未连接"}
      </span>
      <Button
        variant="secondary"
        size="sm"
        isDisabled={busy || disabled}
        onPress={() => {
          void run(
            status.state === "pending" || status.state === "connected"
              ? "disconnect"
              : "authorize",
          );
        }}
      >
        {status.state === "pending"
          ? "取消授权"
          : status.state === "connected"
            ? "断开账号"
            : "连接账号"}
      </Button>
      {status.state === "failed" && <p role="status">{status.message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function PluginAccounts({
  botId,
  plugin,
  disabled,
}: {
  botId: string;
  plugin: InstalledPlugin;
  disabled: boolean;
}) {
  if (!plugin.enabled) return null;
  return plugin.servers.map((server) => (
    <PluginAccount
      key={`${plugin.id}:${server.name}`}
      botId={botId}
      pluginId={plugin.id}
      server={server}
      disabled={disabled}
    />
  ));
}
