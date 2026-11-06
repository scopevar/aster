import { Button } from "@heroui/react";
import { SettingsSelect } from "../../components/settings/settings-controls.js";
import { useEffect, useRef, useState } from "react";
import { AppError } from "../../../shared/core.js";
import {
  agentConnectionsStatusSchema,
  type AgentConnectionsStatus,
} from "../../../shared/agent-connections.js";
import { desktop, errorMessage } from "../../lib/client.js";
import { toast } from "../../components/toast.js";
import "./bot-model.css";

function useModelConnections() {
  const [status, setStatus] = useState<AgentConnectionsStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void desktop
      .agentConnections({ action: "status" })
      .then((value) => {
        const parsed = agentConnectionsStatusSchema.parse(value);
        if (alive) setStatus(parsed);
      })
      .catch((failure: unknown) => {
        if (alive) setError(errorMessage(failure));
      });
    return () => {
      alive = false;
    };
  }, []);
  return { status, setStatus, error, setError };
}

function ModelSelect({
  status,
  value,
  disabled,
  onChange,
}: {
  status: AgentConnectionsStatus | null;
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  const entries = status?.config.connections ?? [];
  const available = entries.filter((entry) => entry.enabled);
  const selected = entries.find((entry) => entry.id === value);
  return (
    <SettingsSelect
      name="connectionId"
      label="Bot 供应商"
      value={value}
      disabled={disabled || !status || !available.length}
      onChange={onChange}
      options={[
        {
          value: "",
          disabled: Boolean(value),
          label: !status
            ? "正在读取供应商…"
            : available.length
              ? "请选择供应商"
              : "暂无启用的供应商",
        },
        ...(value && !selected?.enabled
          ? [
              {
                value,
                label: `${value}（${selected ? "已停用" : "已删除"}）`,
                disabled: true,
              },
            ]
          : []),
        ...available.map((entry) => ({
          value: entry.id,
          label: `${entry.id} · ${entry.model}`,
        })),
      ]}
    />
  );
}

export function BotModelChoice({
  disabled,
  initialConnection = "",
}: {
  disabled: boolean;
  initialConnection?: string;
}) {
  const { status, error } = useModelConnections();
  const [value, setValue] = useState(initialConnection);
  return (
    <label className="bot-model-choice">
      模型供应商
      <ModelSelect
        status={status}
        value={value}
        disabled={disabled}
        onChange={setValue}
      />
      <small>此 Bot 独立使用所选模型，也可稍后在 Bot 设置中选择。</small>
      {error && (
        <small className="error" role="alert">
          {error}
        </small>
      )}
    </label>
  );
}

export function BotModelSettings({ botId }: { botId: string }) {
  const { status, setStatus, error, setError } = useModelConnections();
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const save = async (connectionId: string) => {
    setBusy(true);
    setError("");
    setUncertain(connectionId);
    try {
      const next = agentConnectionsStatusSchema.parse(
        await desktop.agentConnections({
          action: "assign",
          botId,
          connectionId,
        }),
      );
      if (!alive.current) return;
      setStatus(next);
      setUncertain(null);
      toast.success("已更新 Bot 供应商，下一回合生效", { timeout: 5000 });
    } catch (failure) {
      if (alive.current) {
        if (
          failure instanceof AppError &&
          ["invalid_input", "not_found", "unauthorized", "conflict"].includes(
            failure.code,
          )
        )
          setUncertain(null);
        setError(errorMessage(failure));
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <div className="bot-model-settings">
      <label>
        <span>
          模型供应商<small>每个 Bot 独立配置，下一回合生效</small>
        </span>
        <ModelSelect
          status={status}
          value={uncertain ?? status?.config.botConnections?.[botId] ?? ""}
          disabled={busy || uncertain !== null}
          onChange={(value) => {
            void save(value);
          }}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {error && uncertain && (
        <Button
          variant="secondary"
          type="button"
          isDisabled={busy}
          onPress={() => {
            void save(uncertain);
          }}
        >
          重试保存供应商
        </Button>
      )}
    </div>
  );
}
