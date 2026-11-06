import { useState } from "react";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { desktop, errorMessage } from "../../lib/client.js";
import type { ConversationViewModel } from "../conversations/use-conversation-session.js";
import type { useCommandQueue } from "../../lib/use-command-queue.js";
import {
  readPendingBotCreate,
  reserveBotCreate,
  type PendingBotCreate,
} from "./pending-bot-create.js";

export function useBotCreation(
  session: Pick<ConversationViewModel, "navigation" | "select">,
  act: ReturnType<typeof useCommandQueue>["act"],
  onClose: () => void,
) {
  const { navigation, select } = session;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createDraft, setCreateDraft] = useState<PendingBotCreate | null>(null);
  const [createNotice, setCreateNotice] = useState("");
  const restoreCreate = async () => {
    const { pending } = await readPendingBotCreate();
    setCreateDraft(pending);
    setCreateNotice(pending ? "创建请求等待确认。" : "");
    setName(pending?.request.command.name ?? "");
    setDescription(pending?.request.command.description ?? "");
    setError("");
  };
  const create = async (
    newName: string,
    newDescription: string,
    connectionId = "",
  ) => {
    setCreateNotice("");
    const command: Command = {
      type: "bot.create",
      name: newName,
      description: newDescription,
    };
    const pending = await reserveBotCreate(command, connectionId);
    const generation = navigation.current;
    const result = await act(command, pending.request);
    if (result?.conversationId) {
      if (connectionId) {
        if (!result.id)
          throw new Error("Bot 标识尚未确认，无法保存供应商。请重试原请求。");
        try {
          await desktop.agentConnections({
            action: "assign",
            botId: result.id,
            connectionId,
          });
        } catch (failure) {
          throw new Error(
            `Bot 已创建，供应商保存未确认。请重试，不会重复创建 Bot。${errorMessage(failure)}`,
          );
        }
      }
      pending.clear();
      onClose();
      if (generation === navigation.current) select(result.conversationId);
    } else throw new Error("创建未确认，请重试；相同请求不会重复创建。");
  };

  return {
    name,
    setName,
    description,
    setDescription,
    busy,
    setBusy,
    error,
    setError,
    createDraft,
    createNotice,
    restoreCreate,
    create,
  };
}
export type BotCreationModel = ReturnType<typeof useBotCreation>;
