import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/core.js";
import { type Envelope } from "../../shared/commands.js";
import type { DesktopEnvelope } from "../../shared/desktop/desktop-commands.js";

type Consent = {
  root: string;
  conversationId: string;
  epoch: string;
  owner: number;
  expiresAt: number;
  commandId?: string;
};
const consentLifetimeMs = 5 * 60 * 1000;

/** One grant per dialog choice; only an identical command ID may retry its redemption. */
export class DirectoryConsent {
  private readonly grants = new Map<string, Consent>();
  issue(input: Omit<Consent, "expiresAt" | "commandId">, now = Date.now()) {
    for (const [id, grant] of this.grants)
      if (grant.expiresAt <= now) this.grants.delete(id);
    if (this.grants.size >= 64)
      throw new AppError("capacity", "待确认的目录授权过多，请稍后重试。");
    const credential = randomUUID();
    this.grants.set(credential, {
      ...input,
      expiresAt: now + consentLifetimeMs,
    });
    return credential;
  }
  authorize(
    request: DesktopEnvelope,
    owner: number,
    now = Date.now(),
  ): Envelope {
    const command = request.command;
    if (command.type !== "directory.attach") return { ...request, command };
    const grant = this.grants.get(command.credential);
    if (
      !grant ||
      grant.owner !== owner ||
      grant.conversationId !== command.conversationId ||
      grant.expiresAt <= now ||
      (grant.commandId !== undefined && grant.commandId !== request.id)
    )
      throw new AppError(
        "unauthorized",
        "目录选择凭据无效或已使用，请重新选择目录。",
      );
    grant.commandId = request.id;
    return {
      ...request,
      expectedEpoch: grant.epoch,
      command: {
        type: "directory.attach",
        conversationId: grant.conversationId,
        root: grant.root,
      },
    };
  }
  clear() {
    this.grants.clear();
  }
}
