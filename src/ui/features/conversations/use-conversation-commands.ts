import { useRef, useState } from "react";
import type { Conversation } from "../../../shared/chat/conversations.js";
import type {
  DesktopCommand as Command,
  DesktopEnvelope as Envelope,
} from "../../../shared/desktop/desktop-commands.js";
import { envelope } from "../../lib/client.js";
import type { ConversationViewModel } from "./use-conversation-session.js";
import type { useCommandQueue } from "../../lib/use-command-queue.js";
export function useConversationCommands(
  session: Pick<ConversationViewModel, "navigation" | "select">,
  act: ReturnType<typeof useCommandQueue>["act"],
) {
  const { navigation, select } = session;
  const [busy, setBusy] = useState(false);
  const opening = useRef(false);
  const conversationRequest = useRef<Envelope | null>(null);
  const updateConversation = (
    c: Conversation,
    patch: Partial<Pick<Conversation, "hidden" | "pinned">>,
  ) =>
    act({
      type: "conversation.update",
      conversationId: c.id,
      hidden: c.hidden,
      pinned: c.pinned,
      ...patch,
    });
  const openConversation = async (botId: string) => {
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    const generation = navigation.current;
    const command: Command = { type: "conversation.create", botId };
    if (
      !conversationRequest.current ||
      JSON.stringify(conversationRequest.current.command) !==
        JSON.stringify(command)
    )
      conversationRequest.current = envelope(command);
    try {
      const result = await act(command, conversationRequest.current);
      if (result?.conversationId) {
        conversationRequest.current = null;
        if (generation === navigation.current) select(result.conversationId);
      }
    } finally {
      opening.current = false;
      setBusy(false);
    }
  };
  return {
    busy,
    setBusy,
    openConversation,
    updateConversation,
  };
}
export type ConversationCommandsViewModel = ReturnType<
  typeof useConversationCommands
>;
