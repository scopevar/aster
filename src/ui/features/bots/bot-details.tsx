import { IconButton } from "../../components/icon-button.js";
import { Button, Input, TextArea } from "@heroui/react";
import { SettingsSelect } from "../../components/settings/settings-controls.js";
import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useState, useCallback, useRef, type KeyboardEvent } from "react";
import type { Bot } from "../../../shared/chat/bots.js";
import type { CommandResult } from "../../../shared/core.js";
import { Avatar } from "../../components/icons.js";
import { AvatarEditor } from "../../components/avatar/avatar-editor.js";
import { RoutineManager } from "../routines/routines.js";
import { RoutineOverview } from "../routines/routine-overview.js";
import { useBotPreferences } from "./use-bot-preferences.js";
import { BotModelSettings } from "./bot-model.js";
import "./bot-preferences.css";

export function BotDetails({
  bot,
  view,
  act,
  onConversation,
}: {
  bot: Bot;
  onConversation(id: string): void;
  view: "overview" | "settings";
  act(command: Command, request?: Envelope): Promise<CommandResult | undefined>;
}) {
  const preferences = useBotPreferences(bot, act);
  const draft = preferences.values;
  const [avatarAnchor, setAvatarAnchor] = useState<HTMLButtonElement | null>(
    null,
  );
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [routineId, setRoutineId] = useState<string>();
  const closeAvatar = useCallback(() => setAvatarAnchor(null), []);
  const skipBlur = useRef(false);
  const fieldKey = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    field: "name" | "tags" | "description",
  ) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      skipBlur.current = true;
      preferences.revert(field);
      event.currentTarget.blur();
    } else if (event.key === "Enter" && field !== "description") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };
  const commitField = (field: "name" | "tags" | "description") => {
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    if (field === "name" && !draft.name.trim()) preferences.revert("name");
    void preferences.save();
  };
  return (
    <aside
      className={`details bot-details ${view}`}
      aria-label={view === "overview" ? "Bot 概览" : "Bot 设置"}
    >
      {view === "overview" ? (
        <>
          <RoutineOverview
            key={`routines:${bot.id}`}
            botId={bot.id}
            suspended={routinesOpen}
            onOpen={(id) => {
              setRoutineId(id);
              setRoutinesOpen(true);
            }}
          />
        </>
      ) : (
        <>
          <div className="settings-avatar">
            <IconButton
              variant="ghost"
              className="avatar-edit-trigger"
              aria-label="编辑 Bot 头像"
              aria-expanded={!!avatarAnchor}
              onPress={(event) => {
                if (event.target instanceof HTMLButtonElement)
                  setAvatarAnchor(avatarAnchor ? null : event.target);
              }}
            >
              <Avatar name={bot.name} appearance={bot.avatar} botId={bot.id} />
            </IconButton>
            {avatarAnchor && (
              <AvatarEditor
                anchor={avatarAnchor}
                bot={bot}
                act={act}
                onClose={closeAvatar}
              />
            )}
          </div>
          <form
            className="bot-settings-form"
            onSubmit={(event) => event.preventDefault()}
          >
            <fieldset aria-busy={preferences.busy}>
              <label>
                <span className="preference-label">名称</span>
                <Input
                  variant="secondary"
                  fullWidth
                  required
                  maxLength={80}
                  readOnly={preferences.locked}
                  value={draft.name}
                  onBlur={() => commitField("name")}
                  onKeyDown={(event) => fieldKey(event, "name")}
                  onChange={(event) =>
                    preferences.change({ name: event.target.value })
                  }
                />
              </label>
              <label>
                <span className="preference-label">标签（可选）</span>
                <Input
                  variant="secondary"
                  fullWidth
                  maxLength={240}
                  readOnly={preferences.locked}
                  placeholder="研究、市场、行政"
                  value={draft.tags}
                  onBlur={() => commitField("tags")}
                  onKeyDown={(event) => fieldKey(event, "tags")}
                  onChange={(event) =>
                    preferences.change({ tags: event.target.value })
                  }
                />
              </label>
              <label>
                <span className="preference-label">描述</span>
                <TextArea
                  variant="secondary"
                  fullWidth
                  aria-label="Bot 描述"
                  maxLength={4000}
                  readOnly={preferences.locked}
                  placeholder="详细说明用途和工作方式"
                  value={draft.description}
                  onBlur={() => commitField("description")}
                  onKeyDown={(event) => fieldKey(event, "description")}
                  onChange={(event) =>
                    preferences.change({ description: event.target.value })
                  }
                />
              </label>
              <BotModelSettings key={bot.id} botId={bot.id} />
              <div className="bot-preferences">
                <div>
                  <span>语音</span>
                  <span className="preference-unavailable" title="语音尚未接入">
                    未设置
                  </span>
                </div>
                <div>
                  <span>速度</span>
                  <span className="preference-unavailable" title="语音尚未接入">
                    不可用
                  </span>
                </div>
                <div>
                  <span>语言</span>
                  <SettingsSelect
                    label="回复语言"
                    disabled={preferences.locked}
                    value={draft.language}
                    onChange={(value) => {
                      if (
                        value === "auto" ||
                        value === "zh-CN" ||
                        value === "en" ||
                        value === "ja"
                      ) {
                        preferences.change({ language: value });
                        void preferences.save();
                      }
                    }}
                    options={[
                      { value: "auto", label: "自动检测" },
                      { value: "zh-CN", label: "简体中文" },
                      { value: "en", label: "English" },
                      { value: "ja", label: "日本語" },
                    ]}
                  />
                </div>
                <div>
                  <span>
                    通知<small>系统通知尚未接入</small>
                  </span>
                  <span className="preference-unavailable">不可用</span>
                </div>
              </div>
            </fieldset>
            <span className="sr-only" role="status">
              {preferences.status}
            </span>
            {(preferences.error ||
              (preferences.pending && !preferences.busy)) && (
              <div className="preferences-recovery">
                <p role="alert">
                  {preferences.error || "上次保存结果尚未核实。"}
                </p>
                <Button
                  variant="secondary"
                  type="button"
                  isDisabled={preferences.busy}
                  onPress={() =>
                    preferences.blocked
                      ? preferences.resetUnreadable()
                      : void preferences.save()
                  }
                >
                  {preferences.blocked
                    ? "备份记录并重新编辑"
                    : preferences.pending
                      ? "核实保存"
                      : "重试保存"}
                </Button>
              </div>
            )}
          </form>
        </>
      )}
      {routinesOpen && (
        <RoutineManager
          botId={bot.id}
          initialRoutineId={routineId}
          onClose={() => setRoutinesOpen(false)}
          onConversation={onConversation}
        />
      )}
    </aside>
  );
}
