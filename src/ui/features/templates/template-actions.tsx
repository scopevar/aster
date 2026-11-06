import { storedDesktopEnvelopeSchema as envelopeSchema } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import { Dropdown } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { AppError } from "../../../shared/core.js";
import { desktop, envelope, execute, errorMessage } from "../../lib/client.js";
import { Icon } from "../../components/icons.js";
import { Tooltip } from "../../components/tooltip.js";
import "./template-actions.css";

const templatePrompt =
  "请为你自己创建一个本地模板草稿。先核对可携带的技能和例行任务，只创建草稿供我查看并选择导出模板文件。";

/** One conversation owns the request until its committed reply is confirmed. */
export function TemplateActions({
  conversationId,
  onManage,
  onRequested,
}: {
  conversationId: string;
  onManage(): void;
  onRequested(): void;
}) {
  const key = `template-prompt:${conversationId}`;
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { request: null, damaged: false, error: "" };
      const request = envelopeSchema.parse(JSON.parse(raw));
      if (
        request.command.type !== "message.prompt" ||
        request.command.conversationId !== conversationId ||
        request.command.text !== templatePrompt
      )
        throw Error("请求归属或内容不符。");
      return {
        request,
        damaged: false,
        error: "上次请求尚未确认，请重试原请求。",
      };
    } catch {
      return {
        request: null,
        damaged: true,
        error: "模板请求记录无法读取，原记录已保留。请先核对聊天记录。",
      };
    }
  });
  const [pending, setPending] = useState<Envelope | null>(initial.request);
  const [damaged, setDamaged] = useState(initial.damaged);
  const [error, setError] = useState(initial.error);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const alive = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const requestTemplate = async () => {
    if (locked.current || damaged) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const request =
      pending ??
      envelope({
        type: "message.prompt",
        conversationId,
        text: templatePrompt,
      });
    try {
      // Persist before sending. A transport failure can occur after the transaction commits.
      localStorage.setItem(key, JSON.stringify(request));
      setPending(request);
      await execute(request);
      if (localStorage.getItem(key) === JSON.stringify(request))
        localStorage.removeItem(key);
      if (alive.current) {
        setPending(null);
        setOpen(false);
        onRequested();
      }
    } catch (cause) {
      let detail = errorMessage(cause);
      try {
        if (cause instanceof AppError && cause.code !== "unknown") {
          if (localStorage.getItem(key) === JSON.stringify(request))
            localStorage.removeItem(key);
          if (alive.current) setPending(null);
        }
      } catch (storageError) {
        detail += ` 请求记录未能更新：${errorMessage(storageError)}`;
      }
      if (alive.current) setError(detail);
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const preserveDamaged = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        localStorage.setItem(`${key}:backup:${crypto.randomUUID()}`, raw);
        await desktop.copyText(raw);
        if (localStorage.getItem(key) !== raw)
          throw Error("请求记录已变化，请重新打开此会话后核对。");
        localStorage.removeItem(key);
      }
      if (alive.current) {
        setDamaged(false);
        setError("");
        setOpen(false);
      }
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <Tooltip content="模板操作">
        <Dropdown.Trigger
          className="icon-button template-actions-trigger"
          aria-label="模板操作"
        >
          <Icon name="share" size={18} />
          {(pending || damaged) && (
            <span
              className="template-request-indicator"
              aria-label="模板请求待核实"
            />
          )}
        </Dropdown.Trigger>
      </Tooltip>
      <Dropdown.Popover
        placement="bottom end"
        className="template-actions-menu"
      >
        <Dropdown.Menu
          aria-label="模板操作"
          autoFocus="first"
          shouldCloseOnSelect={false}
        >
          <Dropdown.Item
            id="template"
            textValue={
              busy ? "正在请求…" : pending ? "重试模板请求" : "创建模板"
            }
            isDisabled={busy || damaged}
            onAction={() => {
              void requestTemplate();
            }}
          >
            <Icon name="share" size={15} />
            {busy ? "正在请求…" : pending ? "重试模板请求" : "创建模板"}
          </Dropdown.Item>
          {error && (
            <Dropdown.Item
              id="error"
              textValue={error}
              isDisabled
              className="template-request-error"
            >
              <div role="alert">
                <p>{error}</p>
              </div>
            </Dropdown.Item>
          )}
          {damaged && (
            <Dropdown.Item
              id="preserve"
              textValue="已核对聊天，复制并保留损坏记录"
              isDisabled={busy}
              onAction={() => {
                void preserveDamaged();
              }}
            >
              已核对聊天，复制并保留损坏记录
            </Dropdown.Item>
          )}
          {
            <Dropdown.Item
              id="manage"
              textValue="管理本地模板"
              isDisabled={busy}
              onAction={() => {
                setOpen(false);
                onManage();
              }}
            >
              <Icon name="book" size={15} />
              管理本地模板
            </Dropdown.Item>
          }
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
