import { Tooltip } from "../../components/tooltip.js";
import { Button } from "@heroui/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Bot } from "../../../shared/chat/bots.js";
import type { Group } from "../../../shared/chat/conversations.js";
import { Avatar, Icon } from "../../components/icons.js";
import { defaultAvatar } from "../../../shared/avatar.js";

export function GroupInput({
  group,
  bots,
  value,
  input,
  onChange,
  onRecipients,
  onSend,
  onFiles,
  disabled,
}: {
  group: Group;
  bots: Bot[];
  value: string;
  input: RefObject<HTMLTextAreaElement | null>;
  onChange(value: string): void;
  onRecipients(ids: string[], text: string): Promise<boolean>;
  onSend(): void;
  onFiles(files: File[]): void;
  disabled: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const [mention, setMention] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const [active, setActive] = useState(0),
    [saving, setSaving] = useState(false);
  const members = group.memberIds.flatMap((id) =>
    bots.filter((b) => b.id === id),
  );
  const choices = [{ id: "all", name: "所有人" }, ...members].filter((b) =>
    b.name
      .toLocaleLowerCase()
      .includes(mention?.query.toLocaleLowerCase() ?? ""),
  );
  useEffect(() => {
    if (!saving && !disabled && restoreFocus.current) {
      restoreFocus.current = false;
      input.current?.focus();
    }
  }, [saving, disabled, input]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target))
        setMention(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const updateMenu = (text: string, caret: number) => {
    const match = /(?:^|\s)@([^@\s]*)$/.exec(text.slice(0, caret));
    const query = match?.[1];
    setMention(
      query !== undefined
        ? { start: caret - query.length - 1, end: caret, query }
        : null,
    );
    setActive(0);
  };
  const save = async (ids: string[], text: string) => {
    if (saving) return;
    setSaving(true);
    try {
      if (await onRecipients(ids, text)) {
        setMention(null);
        restoreFocus.current = true;
      }
    } finally {
      setSaving(false);
    }
  };
  const choose = (id: string) => {
    if (!mention) return;
    const ids =
      id === "all" ? [] : [...new Set([...group.draftRecipientIds, id])];
    void save(ids, value.slice(0, mention.start) + value.slice(mention.end));
  };
  return (
    <div className="group-input" ref={root}>
      {group.draftRecipientIds.map((id) => (
        <span className="mention-chip" key={id}>
          <Avatar
            small
            botId={id}
            appearance={
              members.find((b) => b.id === id)?.avatar ?? defaultAvatar
            }
          />
          {members.find((b) => b.id === id)?.name ?? "成员"}
          <Tooltip
            content={`取消提及 ${members.find((b) => b.id === id)?.name ?? "成员"}`}
          >
            <Button
              variant="ghost"
              size="sm"
              aria-label={`取消提及 ${members.find((b) => b.id === id)?.name ?? "成员"}`}
              isDisabled={saving || disabled}
              onClick={() => {
                void save(
                  group.draftRecipientIds.filter((x) => x !== id),
                  value,
                );
              }}
            >
              <Icon name="close" size={10} />
            </Button>
          </Tooltip>
        </span>
      ))}
      <textarea
        ref={input}
        aria-label="消息"
        value={value}
        rows={1}
        maxLength={32000}
        placeholder={
          group.draftRecipientIds.length ? "发消息…" : `给 ${group.name} 发消息`
        }
        disabled={disabled || saving}
        aria-controls={mention ? "group-mentions" : undefined}
        aria-expanded={!!mention}
        aria-activedescendant={
          mention && choices[active]
            ? `mention-${choices[active].id}`
            : undefined
        }
        onChange={(e) => {
          onChange(e.target.value);
          updateMenu(e.target.value, e.target.selectionStart);
        }}
        onClick={(e) => updateMenu(value, e.currentTarget.selectionStart)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (files.length) {
            e.preventDefault();
            onFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (mention) {
            if (e.key === "Escape") {
              e.preventDefault();
              setMention(null);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) =>
                Math.max(
                  0,
                  Math.min(
                    choices.length - 1,
                    i + (e.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const choice = choices[active];
              if (choice) choose(choice.id);
              return;
            }
            if (e.key === "Tab") setMention(null);
          }
          if (
            e.key === "Backspace" &&
            !value &&
            group.draftRecipientIds.length
          ) {
            e.preventDefault();
            void save(group.draftRecipientIds.slice(0, -1), value);
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      {mention && (
        <div
          className="mention-menu"
          role="listbox"
          aria-label="提及"
          id="group-mentions"
        >
          {choices.map((b, i) => (
            <button
              role="option"
              aria-selected={i === active}
              id={`mention-${b.id}`}
              key={b.id}
              disabled={saving || disabled}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => choose(b.id)}
            >
              {b.id === "all" ? (
                <span className="mention-all">@</span>
              ) : (
                <Avatar
                  small
                  botId={b.id}
                  appearance={
                    members.find((m) => m.id === b.id)?.avatar ?? defaultAvatar
                  }
                />
              )}
              <span>{b.name}</span>
              <small>Bot</small>
            </button>
          ))}
          {!choices.length && <p>没有匹配的群成员</p>}
        </div>
      )}
    </div>
  );
}
