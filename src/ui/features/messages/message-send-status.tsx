import { IconButton } from "../../components/icon-button.js";
import { Button, Popover, Spinner } from "@heroui/react";
import { useMemo, useState } from "react";
import "./message-send-status.css";

export function MessageSendStatus({
  status,
  startedAt,
  error,
  onRetry,
  onForget,
}: {
  status: "sending" | "confirmed" | "failed" | "unknown";
  startedAt?: number | undefined;
  error?: string | undefined;
  onRetry?: (() => void) | undefined;
  onForget?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const revealDelay = useMemo(
    () =>
      startedAt === undefined ? 300 : Math.max(0, startedAt + 300 - Date.now()),
    [startedAt],
  );
  if (status === "confirmed") return null;
  if (status === "sending")
    return (
      <span
        className="message-send-state message-send-loading"
        style={{ animationDelay: `${revealDelay}ms` }}
        role="status"
        aria-label="发送中"
      >
        <Spinner size="sm" color="current" aria-hidden="true" />
      </span>
    );
  const title = status === "failed" ? "发送失败" : "发送结果未确认";
  return (
    <span className="message-send-state">
      <Popover isOpen={open} onOpenChange={setOpen}>
        <IconButton
          variant="ghost"
          size="sm"
          className="message-send-error"
          aria-label={title}
        >
          <span className="message-send-error-mark" aria-hidden="true">
            !
          </span>
        </IconButton>
        <Popover.Content placement="left" className="message-send-popover">
          <Popover.Dialog aria-label={title}>
            <Popover.Heading>{title}</Popover.Heading>
            <p>
              {status === "unknown"
                ? "暂未确认消息是否发送成功。重试会继续确认这条消息，不会重复发送。"
                : "这条消息未能发送，请查看原因后重试。"}
            </p>
            {error && <p className="message-send-detail">{error}</p>}
            <div className="message-send-buttons">
              {onRetry && (
                <Button
                  size="sm"
                  aria-label="重试发送原消息"
                  onPress={() => {
                    setOpen(false);
                    onRetry();
                  }}
                >
                  重试发送
                </Button>
              )}
              {onForget && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="放弃被拒绝的消息"
                  onPress={() => {
                    setOpen(false);
                    onForget();
                  }}
                >
                  移除消息
                </Button>
              )}
            </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </span>
  );
}
