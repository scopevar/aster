import { useBotCreation } from "../features/bots/use-bot-creation.js";
import { useEffect, useRef, useState } from "react";
import {
  desktop,
  errorMessage,
  subscribeFocusConversation,
} from "../lib/client.js";
import { useAppOverlays } from "./use-app-overlays.js";
import { useCommandQueue } from "../lib/use-command-queue.js";
import { useConversationSession } from "../features/conversations/use-conversation-session.js";
import { useConversationCommands } from "../features/conversations/use-conversation-commands.js";
import { useConversationComposer } from "../features/conversations/use-conversation-composer.js";
import { useSessionDeletion } from "./use-session-deletion.js";
import { useSessionShortcuts } from "./use-session-shortcuts.js";
import { useDesktopPreferences } from "../features/settings/use-desktop-preferences.js";
import { useSidebarPreferences } from "./use-sidebar-preferences.js";
import { toast } from "../components/toast.js";
export function useAppSession() {
  const [error, setError] = useState("");
  useEffect(() => {
    if (!error) return;
    toast.danger(error, { timeout: 5000 });
    setError("");
  }, [error]);
  const [routineError, setRoutineError] = useState("");
  const [openingRoutines, setOpeningRoutines] = useState(false);
  const overlays = useAppOverlays();
  const conversation = useConversationSession(setError);
  const selectConversation = useRef(conversation.select);
  selectConversation.current = conversation.select;
  useEffect(
    () => subscribeFocusConversation((id) => selectConversation.current(id)),
    [],
  );
  const queue = useCommandQueue(conversation.refresh, setError);
  const commands = useConversationCommands(conversation, queue.act);
  const botCreation = useBotCreation(conversation, queue.act, () =>
    overlays.setModal(null),
  );
  const composer = useConversationComposer(
    conversation,
    queue.act,
    queue.submit,
    commands.busy,
    commands.setBusy,
    setError,
  );
  const desktopPreferences = useDesktopPreferences(setError);
  const sidebar = useSidebarPreferences();
  function openRoutines(botId: string, routineId?: string) {
    setRoutineError("");
    setOpeningRoutines(true);
    void desktop
      .openRoutineWindow(botId, routineId)
      .catch((cause) => setRoutineError(errorMessage(cause)))
      .finally(() => setOpeningRoutines(false));
  }
  useSessionShortcuts(overlays.setModal);
  useSessionDeletion(
    conversation,
    overlays,
    composer.retainConversations,
    setError,
  );
  return {
    overlays,
    conversation,
    queue,
    commands,
    botCreation,
    composer,
    desktopPreferences,
    sidebar,
    routines: {
      routineError,
      setRoutineError,
      openingRoutines,
      open: openRoutines,
    },
    errors: { setError },
  };
}
export type AppViewModel = ReturnType<typeof useAppSession>;
export type ErrorViewModel = AppViewModel["errors"];
