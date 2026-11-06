import { Modal } from "../../components/modal.js";
import { Button, Input } from "@heroui/react";
import {
  SettingsDisclosure,
  SettingsSelect,
} from "../../components/settings/settings-controls.js";
import { useState } from "react";
import {
  agentConnectionSchema,
  type AgentConnection,
} from "../../../shared/agent-connections.js";
import { ConnectionAuth } from "./connection-auth.js";
import { Icon } from "../../components/icons.js";
import { Tooltip } from "../../components/tooltip.js";
import type { ProviderPreset } from "./provider-presets.js";
import "./connection-editor.css";

export function ConnectionEditor({
  connection,
  preset,
  isNew,
  busy,
  serverError,
  onSave,
  onCheck,
  onTest,
  onDelete,
  onCancel,
  storedProviders,
}: {
  connection: AgentConnection;
  preset: ProviderPreset | null;
  isNew: boolean;
  busy: boolean;
  serverError: string;
  onSave(value: AgentConnection, apiKey?: string): void;
  onCheck(value: AgentConnection, apiKey?: string): void;
  onTest(value: AgentConnection, apiKey?: string): void;
  onDelete(): void;
  onCancel(): void;
  storedProviders: string[];
}) {
  const [draft, setDraft] = useState(connection);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const hasCredential = storedProviders.includes(draft.provider.trim());
  const needsKey = draft.auth === "stored" && !hasCredential && !apiKey.trim();
  const valid = agentConnectionSchema.safeParse(draft).success && !needsKey;
  const collect = (
    apply: (entry: AgentConnection, apiKey?: string) => void,
  ) => {
    const parsed = agentConnectionSchema.safeParse(draft);
    if (!parsed.success) {
      setError(
        !draft.id.trim()
          ? "请填写连接名称。"
          : !draft.model.trim()
            ? "请填写模型 ID。"
            : (parsed.error.issues[0]?.message ?? "请检查模型配置。"),
      );
      return;
    }
    if (needsKey) {
      setError("请填写 API Key。");
      return;
    }
    setError("");
    apply(
      parsed.data,
      draft.auth === "stored" ? apiKey.trim() || undefined : undefined,
    );
  };
  return (
    <form
      className="connection-editor"
      aria-label="连接配置"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        collect(onSave);
      }}
    >
      <fieldset disabled={busy}>
        {isNew && (
          <header className="connection-editor-heading">
            <div>
              <h1>{preset ? `添加 ${preset.name}` : "添加自定义供应商"}</h1>
              <p>连接兼容的模型 API，为 Pi Agent 配置可用模型。</p>
            </div>
          </header>
        )}
        <section
          className="settings-section"
          aria-labelledby="connection-basic"
        >
          <h2 id="connection-basic">基本信息</h2>
          <div className="setting-group connection-section-body connection-fields">
            <label>
              连接名称 <span className="provider-required">*</span>
              <Input
                variant="secondary"
                fullWidth
                aria-label="连接名称"
                autoComplete="off"
                spellCheck={false}
                value={draft.id}
                maxLength={80}
                placeholder="例如 work-openai"
                onChange={(event) =>
                  setDraft({ ...draft, id: event.target.value })
                }
              />
              <small>
                此设备上的唯一标识，使用字母、数字、下划线或连字符。
              </small>
            </label>
            <label>
              提供商标识 <span className="provider-required">*</span>
              <Input
                variant="secondary"
                fullWidth
                aria-label="模型提供商"
                autoComplete="off"
                spellCheck={false}
                value={draft.provider}
                maxLength={80}
                placeholder="例如 my-provider"
                onChange={(event) =>
                  setDraft({ ...draft, provider: event.target.value })
                }
              />
              <small>
                {draft.api === "native"
                  ? "Pi 内置提供商标识，预设已自动填入。"
                  : "用于识别服务商及查找已保存的认证。"}
              </small>
            </label>
          </div>
        </section>
        <section className="settings-section" aria-labelledby="connection-api">
          <h2 id="connection-api">API 连接</h2>
          <div className="setting-group connection-section-body connection-fields">
            <div className="settings-select-field">
              接口格式 <span className="provider-required">*</span>
              <SettingsSelect
                label="模型接口"
                disabled={busy}
                value={draft.api}
                onChange={(selection) => {
                  const api = agentConnectionSchema.shape.api.parse(selection);
                  setDraft({
                    ...draft,
                    api,
                    auth:
                      draft.auth === "none" &&
                      !["openai-completions", "openai-responses"].includes(api)
                        ? "environment"
                        : draft.auth,
                    apiKeyEnv:
                      draft.apiKeyEnv || preset?.env || "CUSTOM_API_KEY",
                  });
                }}
                options={[
                  { value: "native", label: "Pi 原生提供商" },
                  {
                    value: "openai-completions",
                    label: "OpenAI Chat Completions",
                  },
                  { value: "openai-responses", label: "OpenAI Responses" },
                  { value: "anthropic-messages", label: "Anthropic Messages" },
                  {
                    value: "google-generative-ai",
                    label: "Google Generative AI",
                  },
                ]}
              />
            </div>
            <label>
              Base URL{" "}
              {draft.api !== "native" && (
                <span className="provider-required">*</span>
              )}
              <Input
                variant="secondary"
                fullWidth
                aria-label="接口地址"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  draft.api === "native"
                    ? "留空使用 Pi 内置地址"
                    : "https://api.example.com/v1"
                }
                value={draft.baseUrl}
                onChange={(event) =>
                  setDraft({ ...draft, baseUrl: event.target.value })
                }
              />
              <small>
                {draft.api === "native"
                  ? "可覆盖默认地址；模型与接口能力仍由 Pi 提供。"
                  : "填写服务商提供的 API 基础地址。"}
              </small>
            </label>
          </div>
        </section>
        <section className="settings-section" aria-labelledby="connection-auth">
          <h2 id="connection-auth">身份认证</h2>
          <div className="setting-group connection-section-body">
            <ConnectionAuth
              busy={busy}
              draft={draft}
              preset={preset}
              onChange={(value) => {
                if (value.auth !== draft.auth) setApiKey("");
                setDraft(value);
              }}
              apiKey={apiKey}
              onApiKeyChange={setApiKey}
              hasCredential={hasCredential}
            />
          </div>
        </section>
        <section
          className="settings-section"
          aria-labelledby="connection-model"
        >
          <h2 id="connection-model">模型配置</h2>
          <div className="setting-group connection-section-body">
            <label>
              模型 ID <span className="provider-required">*</span>
              <Input
                variant="secondary"
                fullWidth
                aria-label="模型"
                autoComplete="off"
                spellCheck={false}
                value={draft.model}
                maxLength={160}
                placeholder={preset?.modelHint ?? "例如 my-model-id"}
                onChange={(event) =>
                  setDraft({ ...draft, model: event.target.value })
                }
              />
              <small>
                {draft.api === "native"
                  ? "使用 Pi 内置目录中的模型 ID；目录外模型请选择兼容接口格式。"
                  : "按服务商提供的模型 ID 原样填写，每个连接配置一个模型。"}
              </small>
            </label>
          </div>
        </section>
        <div
          className="connection-validation"
          role="group"
          aria-label="连接验证"
        >
          <span>验证连接</span>
          <div className="connection-test-actions">
            <Tooltip content="检查参数、模型与认证配置">
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onPress={() => collect(onCheck)}
              >
                检查配置
              </Button>
            </Tooltip>
            <Tooltip content="向所选模型发送一次测试请求">
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onPress={() => collect(onTest)}
              >
                真实推理测试
              </Button>
            </Tooltip>
          </div>
        </div>
        <div className="setting-group connection-advanced-group">
          <SettingsDisclosure
            className="connection-disclosure"
            title="高级设置"
          >
            <div className="connection-disclosure-body">
              <div className="settings-select-field">
                推理等级
                <SettingsSelect
                  label="推理等级"
                  disabled={busy}
                  value={draft.thinking}
                  onChange={(selection) =>
                    setDraft({
                      ...draft,
                      thinking:
                        agentConnectionSchema.shape.thinking.parse(selection),
                    })
                  }
                  options={[
                    "off",
                    "minimal",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                  ].map((level) => ({ value: level, label: level }))}
                />
                <small>
                  由 Pi 按模型能力应用；不支持推理的模型会忽略此项。
                </small>
              </div>
              {draft.api !== "native" && (
                <div className="connection-fields">
                  <label>
                    上下文窗口
                    <Input
                      variant="secondary"
                      fullWidth
                      aria-label="上下文窗口"
                      type="number"
                      min="8192"
                      max="2000000"
                      value={draft.contextWindow}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          contextWindow: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    输出上限
                    <Input
                      variant="secondary"
                      fullWidth
                      aria-label="输出上限"
                      type="number"
                      min="256"
                      max="200000"
                      value={draft.maxTokens}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          maxTokens: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <small>单位为 token，输出上限必须小于上下文窗口。</small>
                </div>
              )}
            </div>
          </SettingsDisclosure>
          <SettingsDisclosure
            className="connection-disclosure"
            title="配置预览"
          >
            <div className="connection-disclosure-body">
              <small>当前连接的配置草稿，仅包含认证引用。</small>
              <pre className="connection-json" aria-label="配置预览 JSON">
                {JSON.stringify(draft, null, 2)}
              </pre>
            </div>
          </SettingsDisclosure>
        </div>
        {(error || serverError) && !confirmDelete && (
          <p className="error" role="alert">
            {error || serverError}
          </p>
        )}
        <footer className="connection-editor-footer">
          <div className="connection-footer-row">
            <div className="connection-save-actions">
              <Button variant="ghost" type="button" onPress={onCancel}>
                取消
              </Button>
              <Button variant="primary" type="submit" isDisabled={!valid}>
                {busy ? "处理中…" : isNew ? "添加供应商" : "保存配置"}
              </Button>
            </div>
          </div>
          {!isNew && (
            <div className="connection-footer-meta">
              <Button
                variant="ghost"
                size="sm"
                className="connection-delete-action"
                type="button"
                onPress={() => setConfirmDelete(true)}
              >
                <Icon name="trash" size={12} />
                删除连接
              </Button>
            </div>
          )}
        </footer>
      </fieldset>
      {confirmDelete && (
        <Modal
          title="删除供应商"
          onClose={() => setConfirmDelete(false)}
          busy={busy}
          hideCloseButton
          className="connection-delete-dialog"
        >
          <Modal.Body>
            <p>
              确定删除“{connection.id}”？使用此供应商的 Bot 需要重新选择供应商。
            </p>
            <p>当前正在运行的任务不受影响。</p>
            {serverError && (
              <p className="error" role="alert">
                {serverError}
              </p>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              type="button"
              autoFocus
              isDisabled={busy}
              onPress={() => setConfirmDelete(false)}
            >
              保留连接
            </Button>
            <Button
              variant="danger"
              type="button"
              isDisabled={busy}
              onPress={onDelete}
            >
              {busy ? "正在删除…" : "确认删除"}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </form>
  );
}
