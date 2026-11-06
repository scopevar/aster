import { useLayoutEffect, useRef, useState } from "react";
import type { DetailView } from "./conversation-state.js";
import { errorMessage } from "../../lib/client.js";
import { useWorkerSnapshot } from "../../lib/use-worker-snapshot.js";
import { useConversationHistory } from "./use-conversation-history.js";
import {
  rememberConversation,
  useStartupConversation,
} from "./use-startup-conversation.js";
export function useConversationSession(
  setError: (error: string) => void,
  onNavigate?: () => void,
) {
  const [groupDraft, setGroupDraft] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [detailsView, setDetailsView] = useState<DetailView>("overview");
  const [focusDetails, setFocusDetails] = useState(false);
  useLayoutEffect(() => {
    if (!focusDetails || !details) return;
    const target =
      document.querySelector<HTMLElement>(".details input:not(:disabled)") ??
      document.querySelector<HTMLElement>(".details button:not(:disabled)");
    if (target) {
      setFocusDetails(false);
      target.focus();
    }
  }, [focusDetails, details, detailsView]);
  const suppressedRead = useRef<string | null>(null);
  const reading = useRef(new Set<string>());
  const {
    state,
    setState,
    connected,
    connectionError,
    current,
    synced,
    refresh,
  } = useWorkerSnapshot(selected);
  const conversation = state.conversations.find((c) => c.id === selected);
  const identity = state.bots.find((b) => b.id === conversation?.botId);
  const bot =
    identity && conversation?.group
      ? {
          ...identity,
          name: conversation.group.name,
          description: conversation.group.description,
        }
      : identity;
  const navigation = useRef(0);
  const { historyWindow, setHistoryWindow, jumpToMessage, extendHistory } =
    useConversationHistory(navigation, select, setError);
  const newChatReturn = useRef<{
    id: string;
    details: boolean;
    view: DetailView;
  } | null>(null);
  function select(id: string | null) {
    onNavigate?.();
    if (id === null && selected)
      newChatReturn.current = { id: selected, details, view: detailsView };
    setFocusDetails(false);
    setGroupDraft(false);
    suppressedRead.current = null;
    navigation.current++;
    current.current = id;
    setSelected(id);
    // [Lifecycle]: Clearing the visible messages also invalidates their cursor, even when reselecting the same conversation from search.
    synced.current = null;
    setState((previous) => ({ ...previous, messages: [], runs: [] }));
    setHistoryWindow(null);
    setDetails(false);
    setDetailsView("overview");
    setError("");
    if (id) {
      try {
        rememberConversation(id);
      } catch (cause) {
        setError(
          `无法记住当前聊天，重启后可能无法恢复：${errorMessage(cause)}`,
        );
      }
    }
    void refresh().catch((e) => setError(errorMessage(e)));
  }
  useStartupConversation(
    connected,
    state.conversations,
    navigation,
    select,
    setError,
  );
  const availableBots = state.bots.filter((b) => b.lifecycle === "active");
  const emptyGroup =
    !!conversation?.group && conversation.group.memberIds.length === 0;
  const newChatTarget = state.conversations.find(
    (item) => item.id === newChatReturn.current?.id && !item.deletionPending,
  );
  const running =
    state.runs.find((r) => ["running", "cancelling"].includes(r.status)) ??
    state.runs.find((r) => r.status === "queued");
  const allMessages =
    historyWindow?.conversationId === selected
      ? historyWindow.messages
      : state.messages;
  return {
    groupDraft,
    setGroupDraft,
    selected,
    details,
    setDetails,
    detailsView,
    setDetailsView,
    setFocusDetails,
    suppressedRead,
    reading,
    state,
    connected,
    connectionError,
    current,
    refresh,
    conversation,
    bot,
    navigation,
    select,
    historyWindow,
    setHistoryWindow,
    jumpToMessage,
    extendHistory,
    newChatReturn,
    availableBots,
    emptyGroup,
    newChatTarget,
    running,
    allMessages,
  };
}
export type ConversationViewModel = ReturnType<typeof useConversationSession>;
