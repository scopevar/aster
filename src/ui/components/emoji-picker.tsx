import { Tooltip } from "./tooltip.js";
import { Button, Input, Dropdown } from "@heroui/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnchoredPopover } from "./anchored-popover.js";
import {
  emojiByUnicode,
  emojiCatalog,
  emojiGroups,
  quickEmojis,
} from "../../presentation/emoji.js";
import { Icon } from "./icons.js";

export function EmojiPicker({
  anchor,
  selected,
  recent,
  onSelect,
  onClose,
  actions,
  point,
}: {
  anchor: HTMLElement;
  selected: string[];
  recent: string[];
  onSelect(emoji: string): Promise<boolean>;
  onClose(): void;
  actions?:
    | { label: string; icon: "reply" | "copy"; run(): Promise<void> | void }[]
    | undefined;
  point?: { x: number; y: number } | undefined;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const alive = useRef(true),
    locked = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [expanded, setExpanded] = useState(false),
    [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return emojiCatalog.filter(
      (e) =>
        !term ||
        `${e.unicode} ${e.label} ${e.tags?.join(" ") ?? ""}`
          .toLocaleLowerCase()
          .includes(term),
    );
  }, [query]);
  useEffect(() => {
    if (expanded)
      panel.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [expanded]);
  const choose = async (emoji: string) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await onSelect(emoji);
      if (!alive.current) return;
      if (saved) {
        onClose();
        anchor.focus();
      } else setError("回应未保存，请重试。");
    } catch {
      if (alive.current) setError("回应未保存，请重试。");
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const runAction = async (action: NonNullable<typeof actions>[number]) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await action.run();
      if (alive.current) {
        onClose();
        if (action.icon !== "reply") anchor.focus();
      }
    } catch {
      if (alive.current) setError("操作失败，请重试。");
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const button = (emoji: string) => (
    <Tooltip content={emojiByUnicode.get(emoji)?.label} key={emoji}>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        isDisabled={busy}
        data-emoji={emoji}
        aria-label={`回应 ${emoji}`}
        aria-pressed={selected.includes(emoji)}
        onClick={() => {
          void choose(emoji);
        }}
      >
        {emoji}
      </Button>
    </Tooltip>
  );
  return (
    <AnchoredPopover
      anchor={anchor}
      point={point}
      onClose={onClose}
      panelRef={panel}
      className={`emoji-popover ${expanded ? "expanded" : ""}`}
      label={expanded ? "更多表情" : actions ? "消息操作" : "快捷表情"}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        const buttons = Array.from(
          panel.current?.querySelectorAll<HTMLButtonElement>(
            expanded
              ? "button[data-emoji]:not(:disabled)"
              : "button:not(:disabled)",
          ) ?? [],
        );
        const index = buttons.findIndex((b) => b === document.activeElement);
        if (index >= 0 && (event.key === "Home" || event.key === "End")) {
          event.preventDefault();
          buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus();
          return;
        }
        const step =
          event.key === "ArrowRight"
            ? 1
            : event.key === "ArrowLeft"
              ? -1
              : event.key === "ArrowDown"
                ? expanded
                  ? 8
                  : 1
                : event.key === "ArrowUp"
                  ? expanded
                    ? -8
                    : -1
                  : 0;
        if (step && (index >= 0 || event.key === "ArrowDown")) {
          event.preventDefault();
          buttons[
            Math.max(
              0,
              Math.min(buttons.length - 1, index < 0 ? 0 : index + step),
            )
          ]?.focus();
        }
      }}
    >
      {expanded ? (
        <>
          <label className="emoji-search">
            <Icon name="search" size={15} />
            <Input
              variant="secondary"
              aria-label="搜索表情符号"
              placeholder="搜索表情符号"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="emoji-catalog">
            {!query && recent.length > 0 && (
              <section aria-label="最近使用">
                <h4>最近使用</h4>
                <div className="emoji-grid">{recent.map(button)}</div>
              </section>
            )}
            {emojiGroups.map((group) => {
              const entries = filtered.filter((e) => e.group === group.order);
              return entries.length ? (
                <section key={group.order}>
                  <h4>{group.message}</h4>
                  <div className="emoji-grid">
                    {entries.map((e) => button(e.unicode))}
                  </div>
                </section>
              ) : null;
            })}
            {!filtered.length && <p className="emoji-empty">没有找到表情</p>}
          </div>
        </>
      ) : (
        <div className="emoji-quick">
          {quickEmojis.map(button)}
          <Tooltip content="更多表情">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              aria-label="更多表情"
              onClick={() => setExpanded(true)}
            >
              <Icon name="smile" size={20} />
            </Button>
          </Tooltip>
        </div>
      )}
      {!expanded && actions && (
        <Dropdown.Menu
          className="message-menu-actions"
          aria-label="消息操作"
          onAction={(key) => {
            const action = actions.find((item) => item.label === key);
            if (action) void runAction(action);
          }}
        >
          {actions.map((action) => (
            <Dropdown.Item
              key={action.label}
              id={action.label}
              textValue={action.label}
              isDisabled={busy}
            >
              <Icon name={action.icon} size={15} />
              {action.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      )}

      {error && (
        <p className="emoji-error" role="alert">
          {error}
        </p>
      )}
    </AnchoredPopover>
  );
}
