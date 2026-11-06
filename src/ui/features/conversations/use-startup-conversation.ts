import { useEffect, useRef, type RefObject } from "react";
import type { Conversation } from "../../../shared/chat/conversations.js";
import { errorMessage } from "../../lib/client.js";

export const lastConversationKey = "last-conversation";

export function rememberConversation(id: string) {
  localStorage.setItem(lastConversationKey, id);
}

export function useStartupConversation(
  connected: boolean,
  conversations: Conversation[],
  navigation: RefObject<number>,
  select: (id: string | null) => void,
  setError: (error: string) => void,
) {
  const restored = useRef(false);
  useEffect(() => {
    if (!connected || restored.current) return;
    restored.current = true;
    // A user who already chose a chat or opened the new-chat screen owns navigation.
    if (navigation.current !== 0) return;
    let remembered: string | null = null;
    let storageError = "";
    try {
      remembered = localStorage.getItem(lastConversationKey);
    } catch (cause) {
      storageError = `无法读取上次打开的聊天：${errorMessage(cause)}`;
    }
    const visible = conversations.filter(
      (c) => !c.hidden && !c.deletionPending,
    );
    const target =
      visible.find((c) => c.id === remembered) ??
      visible.reduce<Conversation | undefined>(
        (latest, c) =>
          !latest || c.activityAt > latest.activityAt ? c : latest,
        undefined,
      );
    select(target?.id ?? null);
    if (storageError) setError(storageError);
  }, [connected, conversations, navigation, select, setError]);
}
