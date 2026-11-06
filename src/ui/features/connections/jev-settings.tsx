import { Button, Input } from "@heroui/react";
import { useState } from "react";
import type {
  AgentConnectionsRequest,
  AgentConnectionsStatus,
} from "../../../shared/agent-connections.js";
import { jevConfigSchema } from "../../../shared/chat/group-host.js";
import {
  SettingsDisclosure,
  SettingsSwitch,
} from "../../components/settings/settings-controls.js";

export function JevSettings({
  status,
  busy,
  request,
}: {
  status: AgentConnectionsStatus;
  busy: boolean;
  request(value: AgentConnectionsRequest): Promise<boolean>;
}) {
  const [draft, setDraft] = useState(() =>
    jevConfigSchema.parse(status.config.jev ?? {}),
  );
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const submit = async (test: boolean) => {
    const config = jevConfigSchema.safeParse(draft);
    if (!config.success) {
      setError(config.error.issues[0]?.message ?? "Jev 配置无效。");
      return;
    }
    if ((test || draft.enabled) && !apiKey.trim() && !status.jevHasKey) {
      setError("请填写 Jev API Key。");
      return;
    }
    setError("");
    const succeeded = await request(
      test
        ? {
            action: "jev.test",
            config: config.data,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          }
        : {
            action: "save",
            revision: status.revision,
            config: { ...status.config, jev: config.data },
            ...(apiKey.trim() ? { jevApiKey: apiKey.trim() } : {}),
          },
    );
    if (succeeded && !test) setApiKey("");
  };
  return (
    <SettingsDisclosure title="Jev 辅助决策">
      <form
        className="connection-editor jev-settings"
        aria-label="Jev 配置"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <fieldset disabled={busy}>
          <div className="setting-group connection-section-body connection-fields">
            <div className="connection-footer-row">
              <div>
                <strong>启用 Jev</strong>
                <small>
                  用于群聊调度与脚本审批；未通过审核的脚本交给你确认。
                </small>
              </div>
              <SettingsSwitch
                label="启用 Jev 辅助决策"
                selected={draft.enabled}
                disabled={busy}
                onChange={() => setDraft({ ...draft, enabled: !draft.enabled })}
              />
            </div>
            <label>
              Base URL
              <Input
                variant="secondary"
                fullWidth
                aria-label="Jev Base URL"
                value={draft.baseUrl}
                maxLength={2048}
                spellCheck={false}
                onChange={(event) =>
                  setDraft({ ...draft, baseUrl: event.target.value })
                }
              />
            </label>
            <label>
              模型
              <Input
                variant="secondary"
                fullWidth
                aria-label="Jev 模型"
                value={draft.model}
                maxLength={160}
                spellCheck={false}
                onChange={(event) =>
                  setDraft({ ...draft, model: event.target.value })
                }
              />
            </label>
            <label>
              API Key
              <Input
                variant="secondary"
                fullWidth
                aria-label="Jev API Key"
                type="password"
                autoComplete="new-password"
                value={apiKey}
                maxLength={16000}
                placeholder={
                  status.jevHasKey ? "已配置，留空保持不变" : "输入 API Key"
                }
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
            <small className="connection-auth-help">
              密钥加密保存在执行主机。启用后，群聊信息及审核所需的当前指令、脚本、附件名称和联网域名会发送到此地址。
            </small>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="connection-test-actions">
              <Button
                variant="secondary"
                type="button"
                isDisabled={busy}
                onPress={() => {
                  void submit(true);
                }}
              >
                测试 Jev 连接
              </Button>
              <Button variant="primary" type="submit" isDisabled={busy}>
                保存 Jev 配置
              </Button>
            </div>
          </div>
        </fieldset>
      </form>
    </SettingsDisclosure>
  );
}
