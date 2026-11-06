import { Input, Radio, RadioGroup } from "@heroui/react";
import type { AgentConnection } from "../../../shared/agent-connections.js";
import { Icon } from "../../components/icons.js";
import type { ProviderPreset } from "./provider-presets.js";

export function ConnectionAuth({
  draft,
  preset,
  onChange,
  apiKey,
  onApiKeyChange,
  hasCredential,
  busy,
}: {
  draft: AgentConnection;
  preset: ProviderPreset | null;
  onChange(value: AgentConnection): void;
  apiKey: string;
  onApiKeyChange(value: string): void;
  hasCredential: boolean;
  busy: boolean;
}) {
  let local = false;
  try {
    local = ["127.0.0.1", "localhost", "[::1]"].includes(
      new URL(draft.baseUrl).hostname,
    );
  } catch {
    // An incomplete address cannot use anonymous authentication.
  }
  const allowsAnonymous =
    local && ["openai-completions", "openai-responses"].includes(draft.api);
  const options = [
    {
      value: "stored",
      title: "应用凭证库",
      description: "使用本应用加密保存的认证",
    },
    {
      value: "environment",
      title: "环境变量",
      description: "引用运行环境中的密钥",
    },
    {
      value: "none",
      title: "本机接口无需认证",
      description: "仅限本机 OpenAI 兼容接口",
    },
  ] as const;
  return (
    <>
      <div className="connection-auth-label" id="connection-auth-source">
        密钥来源
      </div>
      <RadioGroup
        variant="secondary"
        orientation="horizontal"
        isDisabled={busy}
        className="connection-auth-options"
        aria-labelledby="connection-auth-source"
        value={draft.auth}
        onChange={(auth) => {
          const option = options.find((item) => item.value === auth);
          if (!option) return;
          onChange({
            ...draft,
            auth: option.value,
            apiKeyEnv: draft.apiKeyEnv || preset?.env || "CUSTOM_API_KEY",
          });
        }}
      >
        {options
          .filter(
            (option) =>
              option.value !== "none" ||
              allowsAnonymous ||
              draft.auth === "none",
          )
          .map((option) => (
            <Radio
              key={option.value}
              value={option.value}
              aria-label={option.title}
              isDisabled={option.value === "none" && !allowsAnonymous}
            >
              <Radio.Content>
                <Radio.Control>
                  <Radio.Indicator />
                </Radio.Control>
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </span>
              </Radio.Content>
            </Radio>
          ))}
      </RadioGroup>
      {draft.auth === "environment" && (
        <label>
          密钥环境变量名 <span className="provider-required">*</span>
          <Input
            variant="secondary"
            fullWidth
            aria-label="密钥环境变量名"
            autoComplete="off"
            spellCheck={false}
            value={draft.apiKeyEnv}
            maxLength={100}
            placeholder={preset?.env || "CUSTOM_API_KEY"}
            onChange={(event) =>
              onChange({ ...draft, apiKeyEnv: event.target.value })
            }
          />
          <small className="connection-auth-help">
            <Icon name="info" size={12} />
            填写变量名称，密钥值在后端配置。
          </small>
        </label>
      )}
      {draft.auth === "stored" && (
        <label>
          API Key{" "}
          {!hasCredential && <span className="provider-required">*</span>}
          <Input
            variant="secondary"
            fullWidth
            aria-label="API Key"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={16000}
            value={apiKey}
            placeholder={
              hasCredential ? "已保存，留空保持不变" : "输入 API Key"
            }
            onChange={(event) => onApiKeyChange(event.target.value)}
          />
          <small className="connection-auth-help">
            <Icon name="info" size={12} />
            {hasCredential
              ? "填写新 Key 可替换已有凭证。"
              : "保存后加密存储在本机。"}
            同一提供商标识共用凭证，不写入连接配置 JSON。
          </small>
        </label>
      )}
      {draft.auth === "none" && (
        <small className="connection-auth-help">
          <Icon name="info" size={12} />
          {allowsAnonymous
            ? "本机连接不发送认证头。"
            : "当前地址或接口不支持免认证，请更换密钥来源。"}
        </small>
      )}
    </>
  );
}
