import { useEffect } from "react";
import { sweepDeletedDrafts } from "./deletion.js";
import type { AppOverlayViewModel } from "./use-app-overlays.js";
import type { ConversationViewModel } from "../features/conversations/use-conversation-session.js";
export function useSessionDeletion(
  session: Pick<
    ConversationViewModel,
    "connected" | "state" | "selected" | "conversation" | "select"
  >,
  overlays: Pick<
    AppOverlayViewModel,
    "setMemoryScope" | "setSkillManager" | "setSkillPreview" | "setPreview"
  >,
  retainConversations: (retained: Set<string>) => void,
  setError: (error: string) => void,
) {
  const { connected, state, selected, conversation, select } = session;
  const { setMemoryScope, setSkillManager, setSkillPreview, setPreview } =
    overlays;
  useEffect(() => {
    if (!connected) return;
    const retained = new Set(state.conversations.map((c) => c.id));
    retainConversations(retained);
    if (selected && (!conversation || conversation.deletionPending)) {
      select(null);
      setMemoryScope(null);
      setSkillManager(false);
      setSkillPreview(null);
      setPreview(null);
    }
    try {
      sweepDeletedDrafts(
        state.deletedClientKeys,
        state.conversations,
        state.bots,
      );
    } catch {
      setError(
        "删除已在后台完成，但本机草稿缓存未能清理，请检查本机存储后重新打开界面。",
      );
    }
  }, [state.revision, connected]);
}
