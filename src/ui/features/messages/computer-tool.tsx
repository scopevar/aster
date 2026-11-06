import { Disclosure } from "../../components/disclosure.js";
import { Button } from "@heroui/react";
import { storedDesktopEnvelopeSchema as envelopeSchema } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import { useEffect, useRef, useState } from "react";
import { AppError } from "../../../shared/core.js";
import {
  actionName,
  toolImageSchema,
  type ComputerTool,
} from "../../../shared/tools/tool-calls.js";
import { envelope, errorMessage } from "../../lib/client.js";
import { useMessageCapabilities } from "./message-capabilities.js";
import { Icon } from "../../components/icons.js";
import { Modal } from "../../components/modal.js";
import "./computer-tool.css";
const statusLabels: Record<ComputerTool["status"], string> = {
  pending: "等待批准",
  approved: "已允许一次",
  running: "执行中",
  cancelling: "正在停止",
  completed: "已完成",
  declined: "已拒绝",
  cancelled: "已取消",
  failed: "失败",
  expired: "已过期",
  unknown: "结果未知",
};
export function ComputerToolCard({ tool }: { tool: ComputerTool }) {
  const reviewing =
    tool.status === "pending" && tool.review?.state === "reviewing";
  let reviewTitle =
    tool.review?.reviewer === "jev" ? "查看 Jev 审核记录" : "查看自动审核依据";
  if (tool.review?.state === "manual") reviewTitle = "已由你决定，查看审核记录";
  else if (reviewing)
    reviewTitle =
      tool.review?.reviewer === "jev" ? "Jev 正在审核本次操作" : "正在审核条件";
  const { execute } = useMessageCapabilities();
  const key = `tool-approval:${tool.id}`;
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [view, setView] = useState(false);
  const alive = useRef(true),
    currentStatus = useRef(tool.status);
  currentStatus.current = tool.status;
  const [pending, setPending] = useState<Envelope | null>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
      const value = envelopeSchema.safeParse(raw);
      return value.success &&
        value.data.command.type === "tool.decide" &&
        value.data.command.id === tool.id &&
        value.data.command.conversationId === tool.conversationId
        ? value.data
        : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (tool.status !== "pending") {
      setError("");
      try {
        localStorage.removeItem(key);
      } catch {
        setError("审批已处理，但本机提交缓存未能清理。");
      }
      setPending(null);
    }
  }, [key, tool.status]);
  const decide = async (decision: "allow" | "decline") => {
    if (busy) return;
    const request =
      pending ??
      envelope({
        type: "tool.decide",
        id: tool.id,
        conversationId: tool.conversationId,
        decision,
      });
    setBusy(true);
    setError("");
    try {
      localStorage.setItem(key, JSON.stringify(request));
      setPending(request);
      await execute(request);
      try {
        localStorage.removeItem(key);
      } catch {
        if (alive.current) setError("审批已保存，但本机提交缓存未能清理。");
      }
      if (alive.current) setPending(null);
    } catch (error) {
      if (currentStatus.current !== "pending") return;
      if (
        error instanceof AppError &&
        ["conflict", "unauthorized", "not_found", "invalid_input"].includes(
          error.code,
        )
      ) {
        try {
          localStorage.removeItem(key);
        } catch {
          if (alive.current)
            setError(
              `${errorMessage(error)} 本机提交缓存也未能清理，请保持窗口打开。`,
            );
          return;
        }
        if (alive.current) setPending(null);
      }
      if (alive.current) setError(errorMessage(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const action = tool.action;
  const description =
    action.type === "script"
      ? `${action.command}\n\n${action.network.length ? `HTTPS：${action.network.join(", ")}` : "网络：禁止"}`
      : action.type === "type"
        ? action.text
        : action.type === "key"
          ? action.keys.join(" + ")
          : action.type === "screenshot"
            ? "读取这个 Bot 当前电脑画面。"
            : action.type === "scroll"
              ? `位置 (${action.x}, ${action.y})，${{ up: "向上", down: "向下", left: "向左", right: "向右" }[action.direction]} ${action.steps} 格`
              : action.type === "click"
                ? `位置 (${action.x}, ${action.y})，${{ left: "左键", middle: "中键", right: "右键" }[action.button]} ${action.count} 次`
                : `位置 (${action.x}, ${action.y})`;
  return (
    <section
      className={`computer-tool ${tool.status}`}
      aria-label={actionName(action)}
    >
      <div className="computer-tool-heading">
        <Icon name="computer" size={16} />
        <strong>{actionName(action)}</strong>
        <span role="status">
          {reviewing && tool.review?.reviewer === "jev"
            ? "Jev 审核中"
            : statusLabels[tool.status]}
        </span>
      </div>
      <pre aria-label="操作内容">{description}</pre>
      {action.type === "type" && /[^\x00-\x7f]/.test(action.text) && (
        <p>这次输入会使用并替换 Bot 电脑内的选区或剪贴板。</p>
      )}
      <p>{tool.detail}</p>
      {tool.review && (
        <Disclosure
          className="computer-review"
          aria-label="自动审核依据"
          title={<>{reviewTitle}</>}
        >
          <p>{tool.review.reason}</p>
          {tool.review.confidence !== undefined && (
            <p>判断置信度：{Math.round(tool.review.confidence * 100)}%</p>
          )}
          <ul>
            {tool.review.rules.map((rule, index) => (
              <li key={index}>
                {{ ask: "先询问", allow: "允许", deny: "拒绝" }[rule.decision]}
                ：{rule.condition}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {tool.status === "pending" && !reviewing && (
        <div className="computer-tool-actions">
          {pending ? (
            <Button
              variant="ghost"
              size="sm"
              isDisabled={busy}
              onClick={() => {
                void decide(
                  pending.command.type === "tool.decide"
                    ? pending.command.decision
                    : "decline",
                );
              }}
            >
              核实审批结果
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                isDisabled={busy}
                onClick={() => {
                  void decide("decline");
                }}
              >
                拒绝
              </Button>
              <Button
                variant="ghost"
                size="sm"
                isDisabled={busy}
                onClick={() => {
                  void decide("allow");
                }}
              >
                允许一次
              </Button>
            </>
          )}
        </div>
      )}
      {tool.hasImage && (
        <Button variant="ghost" size="sm" onClick={() => setView(true)}>
          查看截图
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      {view && <ToolImage tool={tool} onClose={() => setView(false)} />}
    </section>
  );
}
function ToolImage({ tool, onClose }: { tool: ComputerTool; onClose(): void }) {
  const { toolImage } = useMessageCapabilities();
  const [image, setImage] = useState(""),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    setImage("");
    setError("");
    void toolImage({ id: tool.id, conversationId: tool.conversationId })
      .then((value) => {
        const content = toolImageSchema.parse(value);
        if (!disposed) setImage(`data:${content.mime};base64,${content.data}`);
      })
      .catch((error) => {
        if (!disposed) setError(errorMessage(error));
      });
    return () => {
      disposed = true;
    };
  }, [tool.id, tool.conversationId, attempt, toolImage]);
  return (
    <Modal title="电脑操作截图" onClose={onClose} variant="attachment">
      <div className="attachment-preview">
        {image ? (
          <img
            src={image}
            alt="这次工具调用实际读取的电脑画面"
            onError={() => {
              setImage("");
              setError("截图无法解码，请保留诊断后重试。");
            }}
          />
        ) : (
          !error && <p role="status">正在读取截图…</p>
        )}
        {error && (
          <div role="alert">
            <p>{error}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAttempt((n) => n + 1)}
            >
              重试
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
