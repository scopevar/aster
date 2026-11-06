import type { Conversation } from "../../../shared/chat/conversations.js";
export type ConversationEntry = {
  id: string;
  pinned: boolean;
  deletionPending: boolean;
  kind: "agent";
  conversation: Conversation;
};
export function conversationEntries(
  conversations: Conversation[],
): ConversationEntry[] {
  return conversations
    .map(
      (conversation): ConversationEntry => ({
        kind: "agent",
        id: conversation.id,
        pinned: conversation.pinned,
        deletionPending: conversation.deletionPending,
        conversation,
      }),
    )
    .sort((a, b) => b.conversation.activityAt - a.conversation.activityAt);
}
