import type { MessageHistoryResult } from "../../../shared/chat/message-search.js";

export type DetailView = "overview" | "settings";
export type HistoryWindow = MessageHistoryResult & {
  focusedMessageId: string | null;
};
