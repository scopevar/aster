import { Disclosure } from "../../components/disclosure.js";
import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "../../components/icons.js";
import type { PluginCall } from "../../../shared/tools/plugins.js";
import { errorMessage } from "../../lib/client.js";
import { useMessageCapabilities } from "./message-capabilities.js";
import "../plugins/plugins.css";
const labels: Record<PluginCall["status"], string> = {
  pending: "等待批准",
  approved: "已批准一次",
  running: "正在执行",
  completed: "已返回",
  declined: "已拒绝",
  cancelled: "已取消",
  failed: "失败",
  unknown: "结果未知",
};
export function PluginCallCard({ call }: { call: PluginCall }) {
  const { plugins } = useMessageCapabilities();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const decide = async (allow: boolean) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await plugins({
        action: "decide",
        botId: call.botId,
        id: call.id,
        allow,
      });
    } catch (failure) {
      if (alive.current) setError(errorMessage(failure));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section className="plugin-panel plugin-approval" aria-label="插件工具审批">
      <div className="plugin-approval-heading">
        <Icon name="shield" size={18} />
        <div>
          <strong>{call.pluginName}</strong>
          <small>
            {call.server} / {call.tool}
          </small>
        </div>
        <span role="status">{labels[call.status]}</span>
      </div>
      {call.detail && <p className="plugin-approval-detail">{call.detail}</p>}
      <Disclosure title={<>查看调用参数</>}>
        <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
      </Disclosure>
      {call.status === "pending" && (
        <>
          <p className="plugin-approval-note">
            批准后允许插件按这些参数读取或修改外部数据。
          </p>
          <div className="plugin-approval-actions">
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              onPress={() => void decide(false)}
            >
              拒绝
            </Button>
            <Button
              size="sm"
              variant="primary"
              isDisabled={busy}
              onPress={() => void decide(true)}
            >
              允许一次
            </Button>
          </div>
        </>
      )}
      {call.status === "unknown" && <p>请先核实实际结果，避免重复执行。</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
