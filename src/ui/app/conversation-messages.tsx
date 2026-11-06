import type { ConversationViewModel } from "../features/conversations/use-conversation-session.js";
import type { AppOverlayViewModel } from "./use-app-overlays.js";
import type { ConversationCommandsViewModel } from "../features/conversations/use-conversation-commands.js";
import type { CommandQueueViewModel } from "../lib/use-command-queue.js";
import type { ComposerViewModel } from "../features/conversations/use-conversation-composer.js";
import type { DesktopPreferencesViewModel } from "../features/settings/use-desktop-preferences.js";
import type { ErrorViewModel } from "./use-app-session.js";
import { errorMessage } from "../lib/client.js";
import { Messages } from "../features/messages/messages.js";
import { defaultTimeZone } from "../../shared/desktop/preferences.js";

export function ConversationMessages({
  state,
  setError,
  bot,
  conversation,
  setModal,
  openConversation,
  setHistoryWindow,
  setTemplateDraftId,
  connected,
  onOpenRoutines,
  preferences,
  modal,
  preview,
  memoryScope,
  skillManager,
  skillPreview,
  suppressedRead,
  reading,
  act,
  setPreview,
  setSkillPreview,
  current,
  input,
  historyWindow,
  allMessages,
  pendingMessages,
  retrySend,
  extendHistory,
  refresh,
}: Pick<
  ConversationViewModel &
    AppOverlayViewModel &
    ConversationCommandsViewModel &
    CommandQueueViewModel &
    ComposerViewModel &
    DesktopPreferencesViewModel &
    ErrorViewModel,
  | "state"
  | "setError"
  | "bot"
  | "conversation"
  | "setModal"
  | "openConversation"
  | "setHistoryWindow"
  | "setTemplateDraftId"
  | "connected"
  | "preferences"
  | "modal"
  | "preview"
  | "memoryScope"
  | "skillManager"
  | "skillPreview"
  | "suppressedRead"
  | "reading"
  | "act"
  | "setPreview"
  | "setSkillPreview"
  | "current"
  | "input"
  | "historyWindow"
  | "allMessages"
  | "pendingMessages"
  | "retrySend"
  | "extendHistory"
  | "refresh"
> & {
  [K in "conversation" | "bot"]: NonNullable<ConversationViewModel[K]>;
} & {
  onOpenRoutines(botId: string): void;
}) {
  return (
    <Messages
      onOpenGroupMember={(id) => {
        void openConversation(id);
      }}
      onOpenTemplates={(id) => {
        setTemplateDraftId(id);
        setModal("templates");
      }}
      onOpenRoutines={onOpenRoutines}
      timeZone={
        preferences?.timeZone && preferences.timeZone !== "auto"
          ? preferences.timeZone
          : defaultTimeZone
      }
      onRead={(sequence) => {
        if (
          modal ||
          preview ||
          memoryScope ||
          skillManager ||
          skillPreview ||
          !connected ||
          suppressedRead.current === conversation.id ||
          reading.current.has(conversation.id) ||
          (sequence <= conversation.lastReadSequence &&
            !conversation.markedUnread)
        )
          return;
        reading.current.add(conversation.id);
        void act({
          type: "conversation.read",
          conversationId: conversation.id,
          through: sequence,
          readVersion: conversation.readVersion,
        }).finally(() => reading.current.delete(conversation.id));
      }}
      botName={bot.name}
      groupBots={conversation.group ? state.bots : undefined}
      onOpenAttachment={setPreview}
      onOpenSkill={setSkillPreview}
      onReply={async (message) => {
        const result = await act({
          type: "reply.save",
          conversationId: message.conversationId,
          messageId: message.id,
        });
        if (!result) throw new Error("引用未保存。");
        if (current.current === message.conversationId) input.current?.focus();
      }}
      recentEmojis={state.recentEmojis}
      key={conversation.id}
      messages={allMessages}
      pendingMessages={
        historyWindow
          ? []
          : pendingMessages.filter(
              (message) =>
                message.conversationId === conversation.id &&
                message.epoch === state.epoch,
            )
      }
      retrySend={retrySend}
      focusedMessageId={historyWindow?.focusedMessageId ?? null}
      historical={!!historyWindow}
      runs={state.runs}
      hasOlder={historyWindow?.hasOlder ?? state.hasOlder}
      hasNewer={historyWindow?.hasNewer ?? false}
      onNewer={() => extendHistory("after")}
      onLatest={() => {
        setHistoryWindow(null);
        void refresh().catch((cause) => setError(errorMessage(cause)));
      }}
      onOlder={() =>
        extendHistory("before", {
          version: 1,
          conversationId: conversation.id,
          messages: state.messages,
          hasOlder: state.hasOlder,
          hasNewer: false,
          focusedMessageId: null,
        })
      }
      act={act}
    />
  );
}
