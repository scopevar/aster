import { useEffect, useState } from "react";
import { agentConnectionsStatusSchema } from "../../../shared/agent-connections.js";
import { SettingsSwitch } from "../../components/settings/settings-controls.js";
import { SettingsReadError } from "../../components/settings/settings-loading.js";
import { desktop, errorMessage } from "../../lib/client.js";
import { useSettingsData, useSettingsMutation } from "./settings-data.js";

export function ConversationSettings() {
  const [status, setStatus, readStatus] = useSettingsData("connections");
  const { busy, run } = useSettingsMutation();
  const [error, setError] = useState("");
  const load = () => {
    setError("");
    void readStatus(async () =>
      agentConnectionsStatusSchema.parse(
        await desktop.agentConnections({ action: "status" }),
      ),
    ).catch((failure: unknown) => setError(errorMessage(failure)));
  };
  useEffect(() => {
    if (!status) load();
  }, [readStatus]);
  const retain = status?.config.retainCancelledContext ?? true;
  const save = () => {
    setError("");
    void run("connections", async () => {
      try {
        const current = agentConnectionsStatusSchema.parse(
          await desktop.agentConnections({ action: "status" }),
        );
        setStatus(
          agentConnectionsStatusSchema.parse(
            await desktop.agentConnections({
              action: "save",
              revision: current.revision,
              config: { ...current.config, retainCancelledContext: !retain },
            }),
          ),
        );
      } catch (failure) {
        setError(errorMessage(failure));
      }
    });
  };
  return (
    <section className="settings-section" aria-label="对话">
      <h2>对话</h2>
      <div className="setting-group">
        <div className="setting-row">
          <div>
            <span>取消后保留本轮上下文</span>
            <small>
              关闭后，下一轮请求不携带被取消这轮的提问和输出，仍保留此前对话。聊天记录不受影响。
            </small>
          </div>
          <SettingsSwitch
            label="取消后保留本轮上下文"
            selected={retain}
            disabled={!status}
            busy={busy.has("connections")}
            onChange={save}
          />
        </div>
      </div>
      {error && <SettingsReadError error={error} onRetry={load} />}
    </section>
  );
}
