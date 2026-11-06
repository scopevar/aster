import { Tooltip } from "../../components/tooltip.js";
import { IconButton } from "../../components/icon-button.js";
import { Button } from "@heroui/react";
import { PendingMessage } from "../messages/pending-message.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import {
  attachmentAccept,
  type Attachment,
} from "../../../shared/files/attachments.js";
import {
  AttachmentList,
  AttachmentPreview,
  UploadList,
} from "../files/attachments.js";
import { desktop, envelope, errorMessage } from "../../lib/client.js";
import { DirectoryGrants } from "../files/directory-grants.js";
import { Avatar, Icon } from "../../components/icons.js";
import { SkillInput } from "../skills/skill-input.js";
import { SkillManager, SkillPreview } from "../skills/skills.js";
import type { GroupDraftViewModel } from "./use-group-draft.js";
import { SettingsSelect } from "../../components/settings/settings-controls.js";
import "./group-host.css";
const draftKey = "group-recipient-draft";
export function GroupDraftView({
  pendingMessage,
  retryFirstSend,
  bots,
  onClose,
  act,
  uploads,
  draft,
  setDraft,
  skills,
  skillManager,
  setSkillManager,
  skillPreview,
  setSkillPreview,
  setCatalogRevision,
  preview,
  setPreview,
  fileInput,
  mounted,
  query,
  setQuery,
  open,
  setOpen,
  busy,
  setBusy,
  error,
  setError,
  active,
  setActive,
  locked,
  input,
  members,
  missingMembers,
  prepared,
  files,
  pending,
  uploading,
  candidates,
  change,
  choose,
  removeMember,
  send,
  addFiles,
}: GroupDraftViewModel) {
  return (
    <main
      className="conversation-workspace group-draft"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        void addFiles(Array.from(e.dataTransfer.files));
      }}
      onPointerDown={(event) => {
        if (
          event.target instanceof Element &&
          !event.target.closest(".recipient,.recipient-menu")
        )
          setOpen(false);
      }}
    >
      <header className="conversation-header new-conversation-header">
        <div className="recipient">
          <span>收件人：</span>
          {draft.memberIds.map((id) => {
            const bot = bots.find((bot) => bot.id === id);
            return (
              <span className="recipient-chip" key={id}>
                {bot && (
                  <Avatar
                    small
                    botId={bot.id}
                    appearance={bot.avatar}
                    name={bot.name}
                  />
                )}
                {bot?.name ?? "不可用收件人"}
                <Tooltip
                  content={bot ? `移除 ${bot.name}` : "移除不可用收件人"}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={bot ? `移除 ${bot.name}` : "移除不可用收件人"}
                    isDisabled={locked}
                    onClick={() => removeMember(id)}
                  >
                    <Icon name="close" size={12} />
                  </Button>
                </Tooltip>
              </span>
            );
          })}
          <input
            disabled={locked}
            autoFocus
            role="combobox"
            aria-label="群聊收件人"
            aria-expanded={open}
            aria-controls="group-recipients"
            aria-activedescendant={
              open && candidates[active]
                ? `group-candidate-${active}`
                : undefined
            }
            placeholder="搜索或创建 Bot"
            value={query}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") setOpen(false);
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive(Math.min(candidates.length - 1, active + 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive(Math.max(0, active - 1));
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const bot = candidates[active];
                if (bot) choose(bot.id);
              }
              if (e.key === "Tab") setOpen(false);
            }}
          />
        </div>
        <IconButton
          variant="ghost"
          size="sm"
          className="icon-button"
          aria-label="关闭新聊天"
          onClick={onClose}
        >
          <Icon name="close" size={14} />
        </IconButton>
      </header>
      {open && (
        <div
          className="recipient-menu"
          role="listbox"
          id="group-recipients"
          aria-label="群聊成员"
        >
          {candidates.map((bot, index) => (
            <button
              role="option"
              aria-selected={active === index}
              id={`group-candidate-${index}`}
              className={active === index ? "highlight" : ""}
              key={bot.id}
              onClick={() => choose(bot.id)}
            >
              <Avatar
                small
                botId={bot.id}
                appearance={bot.avatar}
                name={bot.name}
              />
              {bot.name}
              <span className="muted small-text">添加到群聊</span>
            </button>
          ))}
          {!candidates.length && (
            <p className="group-no-candidates">
              {bots.length ? "已选择所有可用 Bot" : "请先创建 Bot"}
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="banner">
          {error}
        </p>
      )}
      {draft.pendingSend && !busy && (
        <p role="status" className="banner">
          首条消息的结果尚未确认。点击发送重试原请求；确认之前保留当前草稿，避免重复创建。
        </p>
      )}
      {missingMembers && !draft.pendingSend && (
        <p role="status" className="banner">
          有收件人已不可用。草稿和附件已保留，请移除不可用收件人后继续。
        </p>
      )}
      <section className="conversation">
        <div className="messages">
          {pendingMessage && (
            <PendingMessage
              message={pendingMessage}
              onRetry={() => {
                void retryFirstSend();
              }}
            />
          )}
        </div>
        {members.length > 0 && (
          <div
            className="group-host-picker"
            onPointerDownCapture={() => setOpen(false)}
          >
            <span className="muted small-text">主持人</span>
            <SettingsSelect
              label="新群聊主持人"
              disabled={locked}
              value={
                (draft.hostBotId === undefined
                  ? members[0]?.id
                  : draft.hostBotId) ?? "none"
              }
              options={[
                { value: "none", label: "无主持人 · 轮流讨论" },
                ...members.map((bot) => ({ value: bot.id, label: bot.name })),
              ]}
              onChange={(id) =>
                change({ ...draft, hostBotId: id === "none" ? null : id })
              }
            />
          </div>
        )}
        <div className="composer-wrap">
          <input
            type="file"
            hidden
            multiple
            accept={attachmentAccept}
            aria-label="选择群聊附件"
            ref={fileInput}
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <AttachmentList
            attachments={files}
            onOpen={setPreview}
            {...(locked
              ? {}
              : {
                  onRemove: (f: Attachment) =>
                    uploads.remove(f.id, f.conversationId),
                })}
          />
          <UploadList
            uploads={pending}
            onRetry={uploads.retry}
            onCancel={(f) => uploads.remove(f.id, f.conversationId)}
          />
          {prepared && (
            <DirectoryGrants
              key={prepared.id}
              conversationId={prepared.id}
              grants={prepared.directoryGrants}
              submit={act}
            />
          )}
          <div className="composer">
            <IconButton
              variant="ghost"
              size="sm"
              className="icon-button attach"
              isDisabled={locked || missingMembers || !members.length}
              aria-label="添加附件"
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="plus" size={22} />
            </IconButton>
            <IconButton
              variant="ghost"
              size="sm"
              className="icon-button"
              isDisabled={locked || missingMembers || !members.length}
              aria-label="授权目录"
              onClick={() => {
                void (async () => {
                  if (locked || missingMembers || !members.length) return;
                  setBusy(true);
                  setError("");
                  try {
                    const preparedDraft = {
                      ...draft,
                      prepareMemberIds:
                        draft.prepareMemberIds ?? draft.memberIds,
                    };
                    localStorage.setItem(
                      draftKey,
                      JSON.stringify(preparedDraft),
                    );
                    setDraft(preparedDraft);
                    let id = draft.conversationId;
                    if (!id) {
                      const command: Command = {
                        type: "group.prepare",
                        memberIds: preparedDraft.prepareMemberIds,
                      };
                      const result = await act(command, {
                        ...envelope(command),
                        id: draft.prepareId,
                      });
                      if (!result?.conversationId)
                        throw new Error("目录草稿尚未确认，请重试。");
                      id = result.conversationId;
                      const next = { ...preparedDraft, conversationId: id };
                      localStorage.setItem(draftKey, JSON.stringify(next));
                      setDraft(next);
                    }
                    const credential = await desktop.chooseDirectory(id);
                    if (!credential || !mounted.current) return;
                    await act({
                      type: "directory.attach",
                      conversationId: id,
                      credential,
                    });
                  } catch (cause) {
                    setError(errorMessage(cause));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              <Icon name="file" size={18} />
            </IconButton>
            <SkillInput
              onError={setError}
              input={input}
              skills={skills.filter((s) => draft.memberIds.includes(s.botId))}
              selected={draft.skills}
              disabled={locked || !members.length}
              onManage={() => setSkillManager(true)}
              onPreview={setSkillPreview}
              onSelect={async (refs, text) => {
                const resolved = refs.flatMap((ref) =>
                  [...draft.skills, ...skills]
                    .filter(
                      (s) =>
                        s.id === ref.id &&
                        s.botId === ref.botId &&
                        s.revision === ref.revision,
                    )
                    .slice(0, 1),
                );
                if (resolved.length !== refs.length) {
                  setError("技能目录已变化，请重新选择。");
                  return false;
                }
                return change({ ...draft, text, skills: resolved });
              }}
            >
              <textarea
                ref={input}
                aria-label="群聊消息"
                disabled={locked}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files);
                  if (files.length) {
                    e.preventDefault();
                    void addFiles(files);
                  }
                }}
                placeholder={`发消息给 ${members.map((b) => b.name).join("和") || "Bot"}`}
                value={draft.text}
                maxLength={32000}
                onChange={(e) => change({ ...draft, text: e.target.value })}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
            </SkillInput>
            <Tooltip content="发送群聊消息">
              <Button
                variant="ghost"
                size="sm"
                className="send-button"
                aria-label="发送群聊消息"
                isDisabled={
                  busy ||
                  uploading ||
                  (!draft.pendingSend &&
                    (missingMembers ||
                      !members.length ||
                      (!draft.text.trim() &&
                        !files.length &&
                        !draft.skills.length)))
                }
                onClick={() => {
                  void send();
                }}
              >
                <Icon name="send" />
              </Button>
            </Tooltip>
          </div>
        </div>
      </section>
      {preview && (
        <AttachmentPreview
          attachment={preview}
          onClose={() => setPreview(null)}
        />
      )}
      {skillManager && members.length > 0 && (
        <SkillManager
          bots={members}
          skills={skills}
          act={async (command, request) => {
            const result = await act(command, request);
            if (mounted.current) setCatalogRevision((v) => v + 1);
            return result;
          }}
          onClose={() => {
            setSkillManager(false);
            setCatalogRevision((v) => v + 1);
          }}
        />
      )}
      {skillPreview && (
        <SkillPreview
          skill={skillPreview}
          onClose={() => setSkillPreview(null)}
        />
      )}
    </main>
  );
}
