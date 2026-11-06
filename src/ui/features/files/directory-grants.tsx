import { Button } from "@heroui/react";
import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useState } from "react";
import type { CommandResult } from "../../../shared/core.js";
import { envelope, errorMessage } from "../../lib/client.js";

export function DirectoryGrants({
  conversationId,
  grants,
  submit,
}: {
  conversationId: string;
  grants: { id: string; root: string }[];
  submit(
    command: Command,
    request?: Envelope,
  ): Promise<CommandResult | undefined>;
}) {
  const [pending, setPending] = useState<Envelope | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revoke = async (id: string) => {
    const request =
      pending ?? envelope({ type: "directory.revoke", conversationId, id });
    setPending(request);
    setBusy(true);
    try {
      const result = await submit(request.command, request);
      if (!result) throw Error("撤销尚未确认，请重试；不会重复修改其他授权。");
      setPending(null);
      setError("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  if (!grants.length && !pending) return null;
  return (
    <section aria-label="已授权目录">
      {grants.map((grant) => (
        <div className="directory-grant" key={grant.id}>
          <span>{grant.root}</span>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="compact-button"
            isDisabled={busy || pending !== null}
            aria-label={`撤销目录授权 ${grant.root}`}
            onClick={() => {
              void revoke(grant.id);
            }}
          >
            撤销
          </Button>
        </div>
      ))}
      <small>
        撤销后停止新读取；已经提供给模型的内容仍可能保留在会话上下文中。
      </small>
      {error && (
        <p role="alert">
          {error}{" "}
          <Button
            variant="ghost"
            size="sm"
            type="button"
            isDisabled={busy}
            onClick={() => {
              if (pending?.command.type === "directory.revoke")
                void revoke(pending.command.id);
            }}
          >
            重试撤销
          </Button>
        </p>
      )}
    </section>
  );
}
