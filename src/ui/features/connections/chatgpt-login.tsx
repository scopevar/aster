import { Button } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import {
  chatGPTAuthStatusSchema,
  type ChatGPTAuthRequest,
  type ChatGPTAuthStatus,
} from "../../../shared/chatgpt-auth.js";
import { desktop, errorMessage } from "../../lib/client.js";

export function ChatGPTLogin({
  onChange,
}: {
  onChange(status: ChatGPTAuthStatus): void;
}) {
  const [status, setStatus] = useState<ChatGPTAuthStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const owned = useRef<string | undefined>(undefined);
  const alive = useRef(false);
  const pending = useRef(false);
  const operation = useRef(0);
  const accept = (next: ChatGPTAuthStatus) => {
    if (!alive.current) return;
    setStatus(next);
    onChange(next);
    if (next.state !== "pending") owned.current = undefined;
  };
  const request = async (input: ChatGPTAuthRequest) => {
    if (pending.current) return;
    pending.current = true;
    operation.current++;
    setBusy(true);
    setError("");
    try {
      accept(chatGPTAuthStatusSchema.parse(await desktop.chatGPTAuth(input)));
    } catch (failure) {
      if (alive.current) setError(errorMessage(failure));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void request({ action: "status" });
    return () => {
      alive.current = false;
      if (owned.current)
        void desktop
          .chatGPTAuth({ action: "cancel", id: owned.current })
          .catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (status?.state !== "pending") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const current = operation.current;
      try {
        const next = chatGPTAuthStatusSchema.parse(
          await desktop.chatGPTAuth({ action: "status" }),
        );
        if (stopped) return;
        if (current !== operation.current) {
          timer = setTimeout(() => void poll(), 1000);
          return;
        }
        accept(next);
        if (next.state === "pending")
          timer = setTimeout(() => void poll(), 1000);
      } catch (failure) {
        if (!stopped) {
          setError(errorMessage(failure));
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [status?.state]);
  return (
    <div className="chatgpt-login">
      <p role="status">
        {status?.message ||
          (status?.authenticated
            ? "已连接 ChatGPT 订阅。"
            : status
              ? "使用 ChatGPT 订阅中的可用额度。"
              : "正在读取登录状态…")}
      </p>
      <div className="connection-test-actions">
        {status?.state === "pending" ? (
          <Button
            type="button"
            variant="secondary"
            isDisabled={busy || !status.id}
            onPress={() => {
              if (status.id) void request({ action: "cancel", id: status.id });
            }}
          >
            取消登录
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            isDisabled={busy || !status}
            onPress={() => {
              const id = crypto.randomUUID();
              owned.current = id;
              void request({ action: "start", id });
            }}
          >
            {status?.authenticated ? "重新登录 ChatGPT" : "使用 ChatGPT 登录"}
          </Button>
        )}
        {status?.authenticated && status.state !== "pending" && (
          <Button
            type="button"
            variant="ghost"
            isDisabled={busy}
            onPress={() => void request({ action: "logout" })}
          >
            退出登录
          </Button>
        )}
        {error && status?.state !== "pending" && (
          <Button
            type="button"
            variant="ghost"
            isDisabled={busy}
            onPress={() => void request({ action: "status" })}
          >
            重新读取状态
          </Button>
        )}
      </div>
      <small className="connection-auth-help">
        授权使用现有 ChatGPT 套餐额度。同一 OpenAI
        提供商共用凭据，登录成功会替换已保存的 API Key。
      </small>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
