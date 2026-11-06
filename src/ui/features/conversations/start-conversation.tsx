import { Modal } from "../../components/modal.js";
import { ListBox, SearchField } from "@heroui/react";
import { useId, useLayoutEffect, useState } from "react";
import type { Snapshot } from "../../../shared/snapshot.js";
import { Avatar, Icon } from "../../components/icons.js";
import "./start-conversation.css";

export function StartConversation({
  bots,
  onSelect,
  onClose,
}: {
  bots: Snapshot["bots"];
  onSelect(id: string): void;
  onClose(): void;
}) {
  const dialogId = useId();
  useLayoutEffect(() => {
    document.getElementById(dialogId)?.focus({ preventScroll: true });
  }, [dialogId]);
  const [query, setQuery] = useState("");
  const matches = bots.filter((bot) => bot.name.includes(query));
  return (
    <Modal
      id={dialogId}
      title="新建会话"
      onClose={onClose}
      className="start-conversation-dialog"
      subtitle={
        <p className="start-conversation-subtitle">选择一个 Bot，开始聊天</p>
      }
    >
      <Modal.Body>
        <SearchField
          aria-label="搜索会话"
          variant="secondary"
          className="start-conversation-search"
          value={query}
          onChange={setQuery}
          onSubmit={() => {
            const first = matches[0];
            if (first) onSelect(first.id);
          }}
        >
          <SearchField.Group>
            <SearchField.SearchIcon>
              <Icon name="search" size={16} />
            </SearchField.SearchIcon>
            <SearchField.Input placeholder="搜索 Bot 名称" />
            <SearchField.ClearButton aria-label="清空搜索">
              <Icon name="close" size={16} />
            </SearchField.ClearButton>
          </SearchField.Group>
        </SearchField>
        <div className="start-conversation-section" aria-hidden="true">
          <span>{query ? "搜索结果" : "你的 Bot"}</span>
          <span>{matches.length}</span>
        </div>
        {matches.length ? (
          <ListBox
            className="start-conversation-list"
            aria-label="会话"
            onAction={(key) => onSelect(String(key))}
          >
            {matches.map((bot) => (
              <ListBox.Item
                key={bot.id}
                id={bot.id}
                textValue={bot.name}
                aria-label={bot.name}
              >
                <Avatar
                  botId={bot.id}
                  appearance={bot.avatar}
                  name={bot.name}
                />
                <span className="start-conversation-copy">
                  <span className="start-conversation-name">{bot.name}</span>
                  <span className="start-conversation-description">
                    {bot.description || "开始与 Bot 对话"}
                  </span>
                </span>
                <Icon name="chevron" size={16} />
              </ListBox.Item>
            ))}
          </ListBox>
        ) : (
          <div className="start-conversation-empty" role="status">
            <Icon name="search" size={24} />
            <p>{query ? "没有匹配的会话" : "还没有可用的 Bot"}</p>
            <span>
              {query ? "试试其他 Bot 名称" : "点击左上角 +，新建你的第一个 Bot"}
            </span>
          </div>
        )}
      </Modal.Body>
    </Modal>
  );
}
