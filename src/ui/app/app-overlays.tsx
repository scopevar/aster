import { BotCreateDialog } from "../features/bots/bot-create-dialog.js";
import type { BotCreationModel } from "../features/bots/use-bot-creation.js";
import { Button } from "@heroui/react";
import type * as React from "react";
import type { Attachment } from "../../shared/files/attachments.js";
import type { Conversation } from "../../shared/chat/conversations.js";
import type { Snapshot } from "../../shared/snapshot.js";
import type { MemoryScope, SharedMemoryScope } from "../../shared/memory.js";
import type { MessageSearchHit } from "../../shared/chat/message-search.js";
import {
  type DesktopPreferences,
  type PreferencesChange,
} from "../../shared/desktop/preferences.js";
import type { SkillSummary } from "../../shared/tools/skills.js";
import type { AppModal } from "./app-state.js";
import type { DetailView } from "../features/conversations/conversation-state.js";
import type { StateSetter } from "../lib/react-state.js";
import { AttachmentPreview } from "../features/files/attachments.js";
import { BotCopy } from "../features/bots/bot-copy.js";
import { errorMessage } from "../lib/client.js";
import { DeletionController, type DeletionTarget } from "./deletion.js";
import { MemoryManager } from "../features/memory/memory.js";
import { MessageSearch } from "../features/messages/message-search.js";
import { statusLabel } from "../lib/run-status.js";
import { Modal } from "../components/modal.js";
import type { AppViewModel } from "./use-app-session.js";
import { SearchPalette } from "./search-palette.js";
import { Settings } from "../features/settings/settings.js";
import { SkillManager, SkillPreview } from "../features/skills/skills.js";
import { StartConversation } from "../features/conversations/start-conversation.js";
import { Templates } from "../features/templates/templates.js";
import { PluginManager } from "../features/plugins/plugin-manager.js";
import { LocalPluginSkills } from "../features/plugins/local-plugin-skills.js";
import { LocalMarket } from "../features/market/local-market.js";
import type { useCommandQueue } from "../lib/use-command-queue.js";
import "../features/routines/routines.css";
type Props = {
  botCreation: BotCreationModel;
  onNewBot(): void;
  select: (id: string | null) => void;
  openConversation: AppViewModel["commands"]["openConversation"];
  modal: AppModal;
  state: Snapshot;
  setModal: StateSetter<AppModal>;
  bot: Snapshot["bots"][number] | undefined;
  setDetails: React.Dispatch<React.SetStateAction<boolean>>;
  setDetailsView: StateSetter<DetailView>;
  conversation: Conversation | undefined;
  setCopyBotId: StateSetter<string | null>;
  setMemoryScope: StateSetter<MemoryScope | null>;
  setTemplateDraftId: StateSetter<string | undefined>;
  setSettingsTab: React.Dispatch<React.SetStateAction<string>>;
  jumpToMessage: (hit: MessageSearchHit) => Promise<void>;
  preview: Attachment | null;
  setPreview: StateSetter<Attachment | null>;
  setError: React.Dispatch<React.SetStateAction<string>>;
  memoryScope: MemoryScope | null;
  submit: ReturnType<typeof useCommandQueue>["submit"];
  skillManager: boolean;
  setSkillManager: React.Dispatch<React.SetStateAction<boolean>>;
  skillPreview: SkillSummary | null;
  setSkillPreview: StateSetter<SkillSummary | null>;
  settingsTab: string;
  preferences: DesktopPreferences | null;
  saveDesktopPreferences: (change: PreferencesChange) => Promise<void>;
  setSharedMemory: StateSetter<SharedMemoryScope | null>;
  sharedMemory: SharedMemoryScope | null;
  copyBotId: string | null;
  templateDraftId: string | undefined;
  running: Snapshot["runs"][number] | undefined;
  deleteTarget: DeletionTarget | null;
  setDeleteTarget: StateSetter<DeletionTarget | null>;
  refresh: () => Promise<void>;
  routineError: string;
  setRoutineError: StateSetter<string>;
};
export function AppOverlays({
  botCreation,
  onNewBot,
  select,
  openConversation,
  modal,
  state,
  setModal,
  bot,
  setDetails,
  setDetailsView,
  conversation,
  setCopyBotId,
  setMemoryScope,
  setTemplateDraftId,
  setSettingsTab,
  jumpToMessage,
  preview,
  setPreview,
  setError,
  memoryScope,
  submit,
  skillManager,
  setSkillManager,
  skillPreview,
  setSkillPreview,
  settingsTab,
  preferences,
  saveDesktopPreferences,
  setSharedMemory,
  sharedMemory,
  copyBotId,
  templateDraftId,
  running,
  deleteTarget,
  setDeleteTarget,
  refresh,
  routineError,
  setRoutineError,
}: Props) {
  return (
    <>
      {routineError && (
        <div className="routine-window-error" role="alert">
          <span>{routineError}</span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="关闭提示"
            onPress={() => setRoutineError("")}
          >
            关闭
          </Button>
        </div>
      )}
      {modal === "search" && (
        <SearchPalette
          bots={state.bots}
          conversations={state.conversations}
          onSelect={select}
          onClose={() => setModal(null)}
          actions={[
            {
              id: "local-market",
              label: "本地市场",
              description: "Bot、插件与模板",
              run: () => setModal("market"),
            },
            ...(bot
              ? [
                  {
                    id: "chat-settings",
                    label: "聊天设置",
                    description: "当前聊天",
                    run: () => {
                      setDetails(true);
                      setDetailsView("settings");
                    },
                  },
                ]
              : []),
            ...(bot && !conversation?.group
              ? [
                  {
                    id: "bot-copy",
                    label: "复制 Bot",
                    description: bot.name,
                    run: () => setCopyBotId(bot.id),
                  },
                  {
                    id: "bot-plugins",
                    label: "本地插件",
                    description: bot.name,
                    run: () => setModal("plugins"),
                  },
                  {
                    id: "bot-memory",
                    label: "记忆",
                    description: bot.name,
                    run: () =>
                      setMemoryScope({ botId: bot.id, conversationId: null }),
                  },
                ]
              : []),
            {
              id: "bot-templates",
              label: "本地模板",
              description: bot?.name ?? "本地模板与导入",
              run: () => {
                setTemplateDraftId(undefined);
                setModal("templates");
              },
            },
            ...[
              "通用",
              "模型与连接",
              "数据与备份",
              "共享记忆",
              "更新",
              "应用信息",
            ].map((tab) => ({
              id: `settings-${tab}`,
              label: `设置：${tab}`,
              description:
                tab === "应用信息" ? "版本、版权和第三方许可" : "设置",
              run: () => {
                setSettingsTab(tab);
                setModal("settings");
              },
            })),
            {
              id: "message-search",
              label: "搜索消息",
              description: "查找聊天记录",
              run: () => setModal("message-search"),
            },
          ]}
        />
      )}
      {modal === "message-search" && (
        <MessageSearch
          bots={state.bots}
          conversations={state.conversations}
          onClose={() => setModal(null)}
          onJump={jumpToMessage}
        />
      )}
      {preview && (
        <AttachmentPreview
          attachment={preview}
          onClose={() => setPreview(null)}
        />
      )}
      {modal === "start" && (
        <StartConversation
          bots={state.bots.filter((item) => item.lifecycle === "active")}
          onSelect={(id) => {
            setModal(null);
            void openConversation(id);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "create" && (
        <BotCreateDialog model={botCreation} onClose={() => setModal(null)} />
      )}
      {memoryScope && (
        <MemoryManager
          key={`${memoryScope.botId}:${memoryScope.conversationId}`}
          scope={memoryScope}
          name={
            state.bots.find((b) => b.id === memoryScope.botId)?.name ?? "Bot"
          }
          act={submit}
          onClose={() => setMemoryScope(null)}
        />
      )}
      {skillManager && bot && conversation && (
        <SkillManager
          bots={
            conversation.group
              ? state.bots.filter((b) =>
                  conversation.group?.memberIds.includes(b.id),
                )
              : [bot]
          }
          skills={state.skills}
          act={submit}
          onClose={() => setSkillManager(false)}
        />
      )}
      {skillPreview && (
        <SkillPreview
          skill={skillPreview}
          onClose={() => setSkillPreview(null)}
        />
      )}
      {modal === "settings" && (
        <Settings
          tab={settingsTab}
          onTab={(tab) => {
            setSharedMemory(null);
            setSettingsTab(tab);
          }}
          onClose={() => {
            setSharedMemory(null);
            setModal(null);
          }}
          preferences={preferences}
          onSave={saveDesktopPreferences}
          submit={submit}
          memoryScope={sharedMemory}
          onSharedMemory={setSharedMemory}
        />
      )}
      {copyBotId &&
        state.bots
          .filter((item) => item.id === copyBotId)
          .map((source) => (
            <BotCopy
              key={source.id}
              bot={source}
              onClose={() => setCopyBotId(null)}
              onCopied={(id) => {
                setCopyBotId(null);
                select(id);
              }}
            />
          ))}
      {modal === "templates" && (
        <Templates
          {...(bot ? { bot } : {})}
          {...(templateDraftId ? { initialDraftId: templateDraftId } : {})}
          onClose={() => setModal(null)}
          onConversation={select}
        />
      )}
      {modal === "plugins" && bot && !conversation?.group && (
        <Modal
          title="本地插件"
          className="plugins-dialog"
          onClose={() => setModal(null)}
        >
          <div className="local-plugins">
            <PluginManager
              key={bot.id}
              botId={bot.id}
              onChanged={() => {
                void refresh().catch((cause: unknown) =>
                  setError(errorMessage(cause)),
                );
              }}
            />
            <LocalPluginSkills
              skills={state.skills.filter((skill) => skill.botId === bot.id)}
              onOpen={setSkillPreview}
            />
          </div>
        </Modal>
      )}
      {modal === "market" && (
        <LocalMarket
          state={state}
          {...(bot ? { activeBotId: bot.id } : {})}
          onClose={() => setModal(null)}
          onNewBot={onNewBot}
          onOpenBot={(id) => {
            setModal(null);
            const previous = state.conversations.find(
              (item) =>
                item.botId === id && !item.group && !item.deletionPending,
            );
            if (previous) select(previous.id);
            else void openConversation(id);
          }}
          onConversation={(id) => {
            select(id);
            setModal(null);
          }}
          onChanged={() => {
            void refresh().catch((cause: unknown) =>
              setError(errorMessage(cause)),
            );
          }}
          onSkill={setSkillPreview}
        />
      )}
      <span className="sr-only" role="status">
        {running ? statusLabel[running.status] : ""}
      </span>
      <DeletionController
        target={deleteTarget}
        jobs={state.deletions}
        onClose={() => setDeleteTarget(null)}
        onAccepted={() => {
          select(null);
          setMemoryScope(null);
          setSkillManager(false);
          setSkillPreview(null);
          setPreview(null);
        }}
        onRefresh={refresh}
      />
    </>
  );
}
