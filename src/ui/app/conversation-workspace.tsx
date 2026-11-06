import type * as React from "react";
import type { Conversation } from "../../shared/chat/conversations.js";
import type { Snapshot } from "../../shared/snapshot.js";
import type { MemoryScope } from "../../shared/memory.js";
import type { DetailView } from "../features/conversations/conversation-state.js";
import type { StateSetter } from "../lib/react-state.js";
import type { useAttachments } from "../features/files/attachments.js";
import { BotDetails } from "../features/bots/bot-details.js";
import {
  ConversationComposer,
  type ComposerProps,
} from "../features/conversations/conversation-composer.js";
import { GroupDetails, GroupDraft } from "../features/conversations/groups.js";
import type { useCommandQueue } from "../lib/use-command-queue.js";
export type ConversationWorkspaceProps = {
  composer: ComposerProps;
  groupDraft: boolean;
  availableBots: Snapshot["bots"];
  state: Snapshot;
  attachments: ReturnType<typeof useAttachments>;
  submit: ReturnType<typeof useCommandQueue>["submit"];
  select: (id: string | null) => void;
  setGroupDraft: React.Dispatch<React.SetStateAction<boolean>>;
  bot: Snapshot["bots"][number] | undefined;
  details: boolean;
  conversation: Conversation | undefined;
  openConversation: (botId: string) => Promise<void>;
  detailsView: DetailView;
  addFiles: (files: File[]) => void;
  connected: boolean;
  connectionError: string;
  onOpenRoutines(botId: string): void;
  act: ReturnType<typeof useCommandQueue>["act"];
  setMemoryScope: StateSetter<MemoryScope | null>;
  children: React.ReactNode;
  header: React.ReactNode;
  startPage: React.ReactNode;
};
export function ConversationWorkspace({
  composer,
  groupDraft,
  availableBots,
  state,
  attachments,
  submit,
  select,
  setGroupDraft,
  bot,
  details,
  conversation,
  openConversation,
  detailsView,
  addFiles,
  connected,
  connectionError,
  onOpenRoutines,
  act,
  setMemoryScope,
  children,
  header,
  startPage,
}: ConversationWorkspaceProps) {
  return (
    <>
      {groupDraft ? (
        <GroupDraft
          key={state.epoch}
          bots={availableBots}
          conversations={state.conversations}
          uploads={attachments}
          act={submit}
          onCreated={(id) => select(id)}
          onClose={() => setGroupDraft(false)}
        />
      ) : (
        <main className="conversation-workspace">
          {bot && conversation && header}
          <div
            className={`conversation-layout ${details && bot ? "with-details" : ""}`}
          >
            <section
              className="conversation"
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files")) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                addFiles(Array.from(event.dataTransfer.files));
              }}
            >
              {!connected && (
                <div className="banner" role="alert">
                  <span>{connectionError || "正在连接后台…"}</span>
                </div>
              )}
              {bot && conversation ? (
                <>
                  {children}
                  <ConversationComposer {...composer} />
                </>
              ) : (
                startPage
              )}
            </section>
            {details &&
              bot &&
              conversation &&
              (conversation.group ? (
                <GroupDetails
                  key={conversation.id + detailsView}
                  conversation={conversation}
                  bots={availableBots}
                  view={detailsView}
                  act={act}
                  onOpenBot={(id) => {
                    void openConversation(id);
                  }}
                  onMemory={(id) =>
                    setMemoryScope({
                      botId: id,
                      conversationId: conversation.id,
                    })
                  }
                  onOpenRoutines={onOpenRoutines}
                />
              ) : (
                <BotDetails
                  onConversation={select}
                  key={conversation.id}
                  act={submit}
                  bot={bot}
                  view={detailsView}
                />
              ))}
          </div>
        </main>
      )}
    </>
  );
}
