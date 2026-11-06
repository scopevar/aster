import { z } from "zod";
import { desktopEnvelopeSchema } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopCommand } from "../../../shared/desktop/desktop-commands.js";
import { envelope } from "../../lib/client.js";

type CreateCommand = Extract<DesktopCommand, { type: "bot.create" }>;
export type PendingBotCreate = {
  request: { id: string; command: CreateCommand };
  connectionId: string;
};
const savedSchema = z
  .object({
    request: desktopEnvelopeSchema,
    connectionId: z.string().max(80),
  })
  .strict();

/** Only UI retry bookkeeping. The daemon still owns admission, queues and receipts. */
export async function readPendingBotCreate() {
  const key = "bot-create:local";
  const raw = localStorage.getItem(key);
  let pending: PendingBotCreate | null = null;
  if (raw !== null) {
    try {
      const saved = savedSchema.parse(JSON.parse(raw));
      const command = saved.request.command;
      if (command.type !== "bot.create") throw Error("创建请求类型无效。");
      pending = { ...saved, request: { id: saved.request.id, command } };
    } catch {
      throw Error(
        "上次创建记录无法读取，原记录已保留；请先核实 Bot 是否已创建。",
      );
    }
  }
  return { key, pending };
}

export async function reserveBotCreate(
  command: CreateCommand,
  connectionId: string,
) {
  const { key, pending } = await readPendingBotCreate();
  if (
    pending &&
    JSON.stringify(pending.request.command) !== JSON.stringify(command)
  )
    throw Error(
      "原创建请求尚未确认，不能修改后生成另一个 Bot。请先核实原请求。",
    );
  const saved = pending ?? {
    request: envelope(command),
    connectionId,
  };
  const value = JSON.stringify(saved);
  // Failure to persist must prevent dispatch; unknown outcomes keep this original UUID.
  localStorage.setItem(key, value);
  return {
    request: saved.request,
    clear() {
      if (localStorage.getItem(key) === value) localStorage.removeItem(key);
    },
  };
}
