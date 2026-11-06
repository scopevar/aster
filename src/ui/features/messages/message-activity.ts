import type { Message } from "../../../shared/chat/messages.js";
import type { Run } from "../../../shared/chat/runs.js";

export function messageActivity(messages: Message[], runs: Run[]) {
  const active = runs.find((run) =>
    ["running", "cancelling"].includes(run.status),
  );
  if (!active) return null;
  const user = messages.findLast(
    (message) => message.role === "user" && message.runId === active.id,
  );
  const turn = active.groupTurns.find((item) => item.status === "running");
  const botId = turn?.botId ?? active.botId;
  const ordinal = turn?.ordinal ?? null;
  const hasText = messages.some(
    (message) =>
      message.runId === active.id &&
      message.botId === botId &&
      message.groupOrdinal === ordinal &&
      message.role === "assistant" &&
      !!message.text.trim() &&
      !message.tool &&
      !message.computerTool &&
      !message.pluginCall &&
      !message.question &&
      !message.document &&
      !message.routine &&
      !message.template,
  );
  return {
    runId: active.id,
    messageId: user?.id,
    botId,
    ordinal,
    hasText,
    loading:
      active.status === "running" &&
      (!active.groupTurns.length || !!turn) &&
      !hasText,
    stopping: active.status === "cancelling",
  };
}
