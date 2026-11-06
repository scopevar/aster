import { Button } from "@heroui/react";
import { useEffect, useState } from "react";
import {
  agentConnectionsStatusSchema,
  type AgentConnectionsStatus,
} from "../../shared/agent-connections.js";
import type { Snapshot } from "../../shared/snapshot.js";
import { Avatar, Icon } from "../components/icons.js";
import { desktop, errorMessage } from "../lib/client.js";
import "./start-page.css";

export function StartPage({
  active,
  connected,
  bots,
  busy,
  onModels,
  onNewBot,
  onSelectBot,
}: {
  active: boolean;
  connected: boolean;
  bots: Snapshot["bots"];
  busy: boolean;
  onModels(): void;
  onNewBot(): void;
  onSelectBot(id: string): Promise<void>;
}) {
  const [status, setStatus] = useState<AgentConnectionsStatus | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active || !connected) return;
    let disposed = false;
    void desktop
      .agentConnections({ action: "status" })
      .then((result) => {
        const next = agentConnectionsStatusSchema.parse(result);
        if (!disposed) {
          setStatus(next);
          setError("");
        }
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(errorMessage(cause));
      });
    return () => {
      disposed = true;
    };
  }, [active, connected, attempt]);
  const hasModel = !!status?.config.connections.some(
    (connection) => connection.enabled,
  );
  const hasBots = bots.length > 0;
  const heading = hasBots
    ? "今天，想和谁聊聊？"
    : hasModel
      ? "创建你的第一个助手"
      : "开始你的第一次对话";
  const description = hasBots
    ? "选择一个助手，开始新的对话。"
    : hasModel
      ? "为它起个名字，告诉它你希望它做什么。"
      : "连接你常用的模型，创建一个属于你的 AI 助手。";

  return (
    <section className="start-page" aria-label="开始使用 Aster">
      <div className="start-page-content">
        <img
          className="start-page-mark"
          src="./assets/aster-avatar.png"
          alt=""
          draggable={false}
        />
        <h1>{heading}</h1>
        <p className="start-page-description">{description}</p>
        {hasBots ? (
          <div className="start-page-assistants" aria-label="你的助手">
            {bots.map((bot) => (
              <Button
                key={bot.id}
                variant="ghost"
                className="start-page-assistant"
                aria-label={`与${bot.name}开始对话`}
                isDisabled={busy || !connected}
                onPress={() => {
                  void onSelectBot(bot.id);
                }}
              >
                <Avatar
                  botId={bot.id}
                  appearance={bot.avatar}
                  name={bot.name}
                />
                <span className="start-page-assistant-copy">
                  <strong>{bot.name}</strong>
                  <span>{bot.description || "开始一段新的对话"}</span>
                </span>
                <Icon name="chevron" size={16} />
              </Button>
            ))}
          </div>
        ) : error ? (
          <div className="start-page-notice">
            <p role="alert">无法读取模型配置：{error}</p>
            <Button
              variant="secondary"
              onPress={() => {
                setError("");
                setStatus(null);
                setAttempt((value) => value + 1);
              }}
            >
              <Icon name="refresh" size={16} />
              重试
            </Button>
          </div>
        ) : (
          <div className="start-page-action">
            <Button
              variant="primary"
              isDisabled={!connected || !status}
              onPress={hasModel ? onNewBot : onModels}
            >
              <Icon name={hasModel ? "plus" : "link"} size={17} />
              {!connected || !status
                ? "正在准备…"
                : hasModel
                  ? "创建助手"
                  : "连接模型"}
            </Button>
            <span className="start-page-hint">
              {hasModel
                ? "名称、职责和模型都可以随时调整"
                : "支持云端 API 和本地模型"}
            </span>
          </div>
        )}
        <div className="start-page-secondary">
          <Button
            variant="ghost"
            size="sm"
            isDisabled={!connected}
            onPress={hasBots || !hasModel ? onNewBot : onModels}
          >
            {hasBots ? "创建新助手" : hasModel ? "管理模型连接" : "先创建助手"}
          </Button>
          {(hasBots || !!error) && (
            <Button variant="ghost" size="sm" onPress={onModels}>
              模型设置
            </Button>
          )}
        </div>
        {!hasBots && !error && (
          <ol className="start-page-steps" aria-label="开始步骤">
            {["连接模型", "创建助手", "开始对话"].map((label, index) => (
              <li
                key={label}
                aria-current={index === (hasModel ? 1 : 0) ? "step" : undefined}
                data-complete={hasModel && index === 0}
              >
                <span className="start-page-step-number" aria-hidden="true">
                  {hasModel && index === 0 ? (
                    <Icon name="check" size={12} />
                  ) : (
                    index + 1
                  )}
                </span>
                <span>{label}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
