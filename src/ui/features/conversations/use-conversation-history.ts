import { useCallback, useRef, useState } from "react";
import type { MessageSearchHit } from "../../../shared/chat/message-search.js";
import type { HistoryWindow } from "./conversation-state.js";
import { errorMessage, messageHistory } from "../../lib/client.js";
export function useConversationHistory(
  navigation: React.RefObject<number>,
  select: (id: string | null) => void,
  setError: (error: string) => void,
) {
  const [historyWindow, setWindow] = useState<HistoryWindow | null>(null);
  const activeRequest = useRef<symbol | null>(null);
  const setHistoryWindow = useCallback((window: HistoryWindow | null) => {
    activeRequest.current = null;
    setWindow(window);
  }, []);
  async function jumpToMessage(hit: MessageSearchHit) {
    const generation = navigation.current;
    const page = await messageHistory({
      version: 1,
      direction: "around",
      conversationId: hit.conversationId,
      messageId: hit.messageId,
    });
    if (navigation.current !== generation)
      throw new Error("会话已切换，请重新选择搜索结果。");
    select(hit.conversationId);
    setHistoryWindow({ ...page, focusedMessageId: hit.messageId });
  }
  async function extendHistory(
    direction: "before" | "after",
    latest?: HistoryWindow,
  ) {
    const source = historyWindow ?? latest;
    if (!source || activeRequest.current || !source.messages.length) return;
    const generation = navigation.current;
    const sequence =
      direction === "before"
        ? source.messages[0]!.sequence
        : source.messages.at(-1)!.sequence;
    const request = Symbol();
    activeRequest.current = request;
    try {
      const page = await messageHistory({
        version: 1,
        direction,
        conversationId: source.conversationId,
        sequence,
      });
      if (
        generation !== navigation.current ||
        activeRequest.current !== request
      )
        return;
      setWindow((previous) => {
        const base = previous ?? source;
        if (base.conversationId !== page.conversationId) return previous;
        const merged =
          direction === "before"
            ? [...page.messages, ...base.messages].slice(0, 300)
            : [...base.messages, ...page.messages].slice(-300);
        return {
          ...base,
          messages: merged,
          hasOlder:
            direction === "before"
              ? page.hasOlder
              : base.hasOlder ||
                merged[0]?.sequence !== base.messages[0]?.sequence,
          hasNewer:
            direction === "after"
              ? page.hasNewer
              : base.hasNewer ||
                merged.at(-1)?.sequence !== base.messages.at(-1)?.sequence,
          focusedMessageId: null,
        };
      });
    } catch (cause) {
      if (
        generation === navigation.current &&
        activeRequest.current === request
      )
        setError(errorMessage(cause));
    } finally {
      if (activeRequest.current === request) activeRequest.current = null;
    }
  }
  return {
    historyWindow,
    setHistoryWindow,
    jumpToMessage,
    extendHistory,
  };
}
