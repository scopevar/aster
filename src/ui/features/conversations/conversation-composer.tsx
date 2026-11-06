import { IconButton } from "../../components/icon-button.js";
import { Tooltip } from "../../components/tooltip.js";
import { Button } from "@heroui/react";
import type * as React from "react";
import type { RefObject } from "react";
import type { Attachment } from "../../../shared/files/attachments.js";
import { attachmentAccept } from "../../../shared/files/attachments.js";
import type { Conversation } from "../../../shared/chat/conversations.js";
import type { Snapshot } from "../../../shared/snapshot.js";
import {
  type DesktopPreferences,
  type PreferencesChange,
} from "../../../shared/desktop/preferences.js";
import type { SkillSummary } from "../../../shared/tools/skills.js";
import type { DetailView } from "./conversation-state.js";
import type { StateSetter } from "../../lib/react-state.js";
import type { useAttachments } from "../files/attachments.js";
import { AttachmentList, UploadList } from "../files/attachments.js";
import { desktop } from "../../lib/client.js";
import { ComposerMenu } from "../../components/composer-menu.js";
import { DirectoryGrants } from "../files/directory-grants.js";
import { GroupInput } from "./group-input.js";
import { Icon } from "../../components/icons.js";
import { SkillInput } from "../skills/skill-input.js";
import { MessageInput } from "../../components/message-input.js";
import type { useCommandQueue } from "../../lib/use-command-queue.js";
export type ComposerProps = {
  state: Snapshot;
  attachments: ReturnType<typeof useAttachments>;
  submit: ReturnType<typeof useCommandQueue>["submit"];
  setError: React.Dispatch<React.SetStateAction<string>>;
  bot: Snapshot["bots"][number] | undefined;
  setDetails: React.Dispatch<React.SetStateAction<boolean>>;
  conversation: Conversation | undefined;
  onOpenSettings(tab: string): void;
  setDetailsView: StateSetter<DetailView>;
  busy: boolean;
  addFiles: (files: File[]) => void;
  connected: boolean;
  preferences: DesktopPreferences | null;
  act: ReturnType<typeof useCommandQueue>["act"];
  setPreview: StateSetter<Attachment | null>;
  setSkillPreview: StateSetter<SkillSummary | null>;
  input: RefObject<HTMLTextAreaElement | null>;
  emptyGroup: boolean;
  fileInput: RefObject<HTMLInputElement | null>;
  currentUploads: ReturnType<typeof useAttachments>["uploads"];
  setFocusDetails: React.Dispatch<React.SetStateAction<boolean>>;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  saveDesktopPreferences: (change: PreferencesChange) => Promise<void>;
  setSkillManager: React.Dispatch<React.SetStateAction<boolean>>;
  setDrafts: StateSetter<Record<string, string>>;
  draft: string;
  setDraft: (value: string) => void;
  send: () => Promise<void>;
  running: Snapshot["runs"][number] | undefined;
  uploading: boolean;
};
export function ConversationComposer({
  emptyGroup,
  fileInput,
  addFiles,
  conversation,
  setPreview,
  attachments,
  submit,
  currentUploads,
  act,
  input,
  bot,
  setDetailsView,
  setDetails,
  setError,
  state,
  busy,
  setFocusDetails,
  onOpenSettings,
  preferences,
  setBusy,
  saveDesktopPreferences,
  setSkillManager,
  setSkillPreview,
  setDrafts,
  draft,
  setDraft,
  send,
  running,
  uploading,
  connected,
}: ComposerProps) {
  return (
    <div className="composer-wrap">
      {emptyGroup && (
        <p className="muted" role="status">
          群聊已没有可用成员。请在群聊详情中添加 Bot 后继续，已有记录仍可查看。
        </p>
      )}
      <input
        type="file"
        ref={fileInput}
        multiple
        hidden
        accept={attachmentAccept}
        aria-label="选择附件文件"
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      {conversation && (
        <AttachmentList
          attachments={conversation.draftAttachments}
          onOpen={setPreview}
          onRemove={(file) => attachments.remove(file.id, file.conversationId)}
        />
      )}
      {conversation && (
        <DirectoryGrants
          key={conversation.id}
          conversationId={conversation.id}
          grants={conversation.directoryGrants}
          submit={submit}
        />
      )}
      <UploadList
        uploads={currentUploads}
        onRetry={attachments.retry}
        onCancel={(file) => attachments.remove(file.id, file.conversationId)}
      />
      <div className={`composer ${conversation?.replyTo ? "with-reply" : ""}`}>
        {conversation?.replyTo && (
          <div className="reply-draft" role="region" aria-label="引用回复">
            <Icon name="reply" size={14} />
            <span>{conversation.replyTo.text.replace(/\s+/g, " ")}</span>
            <IconButton
              variant="ghost"
              size="sm"
              className="icon-button"
              aria-label="取消回复"
              onClick={() => {
                void act({
                  type: "reply.save",
                  conversationId: conversation.id,
                  messageId: null,
                }).then((result) => {
                  if (result) input.current?.focus();
                });
              }}
            >
              <Icon name="close" size={14} />
            </IconButton>
          </div>
        )}
        <ComposerMenu
          key={`composer-menu:${conversation?.id ?? "empty"}`}
          disabled={!bot || emptyGroup}
          onFiles={() => fileInput.current?.click()}
        />
        <SkillInput
          onError={setError}
          key={conversation?.id ?? "empty"}
          skills={state.skills}
          selected={conversation?.draftSkills ?? []}
          input={input}
          disabled={busy || !conversation || emptyGroup}
          actions={
            conversation
              ? [
                  ...(conversation.group
                    ? [
                        {
                          id: "members",
                          name: "成员",
                          description: "当前聊天",
                          run: () => {
                            setFocusDetails(true);
                            setDetailsView("overview");
                            setDetails(true);
                          },
                        },
                      ]
                    : []),
                  {
                    id: "chat-settings",
                    name: "聊天设置",
                    description: "当前聊天",
                    run: () => {
                      setFocusDetails(true);
                      setDetailsView("settings");
                      setDetails(true);
                    },
                  },
                  {
                    id: "attach-directory",
                    name: "授权目录",
                    description: "当前聊天 · 本机文件",
                    prepare: async () => {
                      const credential = await desktop.chooseDirectory(
                        conversation.id,
                      );
                      if (!credential) return;
                      const result = await act({
                        type: "directory.attach",
                        conversationId: conversation.id,
                        credential,
                      });
                      if (!result)
                        throw new Error(
                          "目录授权未确认，请核对已授权目录后重试。",
                        );
                    },
                  },
                  ...["个人信息", "通用", "模型与连接", "共享记忆", "更新"].map(
                    (tab) => ({
                      id: `settings-${tab}`,
                      name: `设置：${tab}`,
                      description: "设置",
                      run: () => {
                        onOpenSettings(tab);
                      },
                    }),
                  ),
                  ...(
                    [
                      ["system", "系统"],
                      ["light", "浅色"],
                      ["dark", "深色"],
                    ] as const
                  ).map(([theme, label]) => ({
                    id: `theme-${theme}`,
                    name: `主题：${label}`,
                    description: "设置 · 外观",
                    disabled: !preferences,
                    prepare: async () => {
                      if (!preferences)
                        throw new Error("桌面偏好尚未读取，请稍后重试。");
                      setBusy(true);
                      try {
                        await saveDesktopPreferences({
                          revision: preferences.revision,
                          theme,
                        });
                      } finally {
                        setBusy(false);
                      }
                    },
                  })),
                ]
              : []
          }
          onManage={() => setSkillManager(true)}
          onPreview={setSkillPreview}
          onSelect={async (references, text) => {
            if (!conversation) return false;
            setBusy(true);
            try {
              const result = await act({
                type: "skills.select",
                conversationId: conversation.id,
                references,
                text,
              });
              if (result)
                setDrafts((old) => ({
                  ...old,
                  [conversation.id]: text,
                }));
              return !!result;
            } finally {
              setBusy(false);
            }
          }}
        >
          {conversation?.group ? (
            <GroupInput
              key={conversation.id}
              group={conversation.group}
              bots={state.bots}
              value={draft}
              input={input}
              disabled={busy || emptyGroup}
              onChange={setDraft}
              onFiles={addFiles}
              onSend={() => {
                void send();
              }}
              onRecipients={async (recipientIds, text) => {
                setBusy(true);
                try {
                  const result = await act({
                    type: "group.recipients",
                    conversationId: conversation.id,
                    recipientIds,
                    text,
                  });
                  if (result)
                    setDrafts((old) => ({
                      ...old,
                      [conversation.id]: text,
                    }));
                  return !!result;
                } finally {
                  setBusy(false);
                }
              }}
            />
          ) : (
            <MessageInput
              input={input}
              placeholder={
                conversation?.replyTo
                  ? "回复…"
                  : bot
                    ? `给 ${bot.name} 发消息`
                    : "发消息给 Bot"
              }
              disabled={!bot || busy}
              value={draft}
              onChange={setDraft}
              onFiles={addFiles}
              onSend={() => {
                void send();
              }}
            />
          )}
        </SkillInput>
        {running &&
        !draft.trim() &&
        !conversation?.draftSkills.length &&
        !conversation?.draftAttachments.length ? (
          <Tooltip content="停止回复">
            <Button
              variant="ghost"
              size="sm"
              className="send-button"
              aria-label="停止回复"
              isDisabled={running.status === "cancelling"}
              onClick={() => {
                void act({ type: "run.cancel", runId: running.id });
              }}
            >
              <Icon name="stop" size={18} />
            </Button>
          </Tooltip>
        ) : draft.trim() ||
          conversation?.draftAttachments.length ||
          conversation?.draftSkills.length ? (
          <Tooltip content="发送消息">
            <Button
              variant="ghost"
              size="sm"
              className="send-button"
              aria-label="发送消息"
              isDisabled={!bot || emptyGroup || busy || uploading || !connected}
              onClick={() => {
                void send();
              }}
            >
              <Icon name="send" />
            </Button>
          </Tooltip>
        ) : (
          <div className="voice-actions">
            {bot && !conversation?.group && (
              <Tooltip content="语音识别尚未接入">
                <Button
                  variant="ghost"
                  size="sm"
                  className="icon-button dictation"
                  aria-label="开始语音输入（尚未可用）"
                  aria-disabled="true"
                  onClick={() =>
                    setError("语音识别尚未接入，暂时请使用文本输入。")
                  }
                >
                  <Icon name="microphone" size={17} />
                </Button>
              </Tooltip>
            )}
            <Tooltip
              content={
                conversation?.group ? "语音识别尚未接入" : "实时语音尚未接入"
              }
            >
              <Button
                variant="ghost"
                size="sm"
                className="send-button"
                aria-label={
                  conversation?.group
                    ? "开始语音输入（尚未可用）"
                    : "发起语音聊天（尚未可用）"
                }
                aria-disabled="true"
                onClick={() =>
                  setError(
                    conversation?.group
                      ? "语音识别尚未接入，暂时请使用文本输入。"
                      : "实时语音尚未接入。",
                  )
                }
              >
                <Icon
                  name={bot && !conversation?.group ? "voice" : "microphone"}
                  size={19}
                />
              </Button>
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  );
}
