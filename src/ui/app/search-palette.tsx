import { useEffect, useId, useRef, useState } from "react";
import type { Bot } from "../../shared/chat/bots.js";
import type { Conversation } from "../../shared/chat/conversations.js";
import { Avatar, Icon } from "../components/icons.js";
import { Modal } from "../components/modal.js";
import { GroupAvatar } from "../features/conversations/groups.js";

export interface SearchAction {
  id: string;
  label: string;
  description: string;
  run(): void;
}
export function SearchPalette({
  bots,
  conversations,
  actions,
  onSelect,
  onClose,
}: {
  bots: Bot[];
  conversations: Conversation[];
  actions: SearchAction[];
  onSelect(id: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const entries = [
    ...conversations
      .filter((c) => !c.hidden && !c.group?.draft && !c.deletionPending)
      .flatMap((c) => {
        const bot = bots.find((bot) => bot.id === c.botId);
        return bot
          ? [
              {
                id: c.id,
                label: c.group?.name ?? bot.name,
                description: c.group?.description ?? bot.description,
                tags: bot.tags,
                bot: true,
                identity: bot,
                group: c.group,
                run: () => onSelect(c.id),
              },
            ]
          : [];
      }),
    ...actions.map((action) => ({
      ...action,
      tags: "",
      bot: false,
      identity: null,
      group: null,
    })),
  ].filter((entry) =>
    (entry.label + entry.description + entry.tags)
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const selected = Math.min(active, Math.max(0, entries.length - 1));
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, query]);
  const choose = (index: number) => {
    const entry = entries[index];
    if (entry) {
      onClose();
      entry.run();
    }
  };
  return (
    <Modal
      title="搜索"
      onClose={onClose}
      variant="search-palette"
      hideHeader
      hideCloseButton
    >
      <label className="palette-input">
        <Icon name="search" size={16} />
        <input
          autoFocus
          role="combobox"
          aria-label="搜索"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${id}-results`}
          aria-activedescendant={
            entries[selected] ? `${id}-${selected}` : undefined
          }
          placeholder="搜索"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive(
                Math.max(
                  0,
                  Math.min(
                    entries.length - 1,
                    selected + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            }
            if (event.key === "Enter") {
              event.preventDefault();
              choose(selected);
            }
          }}
        />
      </label>
      <div
        className="palette-results"
        ref={list}
        id={`${id}-results`}
        role="listbox"
        aria-label="结果"
      >
        {entries.map((entry, index) => (
          <button
            type="button"
            role="option"
            id={`${id}-${index}`}
            key={entry.id}
            aria-selected={selected === index}
            tabIndex={-1}
            onPointerMove={() => setActive(index)}
            onClick={() => choose(index)}
          >
            {entry.bot ? (
              entry.group ? (
                <GroupAvatar
                  small
                  members={entry.group.memberIds.flatMap((id) =>
                    bots.filter((b) => b.id === id),
                  )}
                />
              ) : entry.identity ? (
                <Avatar
                  small
                  name={entry.label}
                  botId={entry.identity.id}
                  appearance={entry.identity.avatar}
                />
              ) : null
            ) : (
              <span className="palette-action-icon">
                <Icon
                  name={entry.id === "message-search" ? "search" : "settings"}
                  size={15}
                />
              </span>
            )}
            <span>
              <strong>{entry.label}</strong>
              {entry.description && <small>{entry.description}</small>}
            </span>
          </button>
        ))}
        {!entries.length && <p className="palette-empty">无结果</p>}
      </div>
    </Modal>
  );
}
