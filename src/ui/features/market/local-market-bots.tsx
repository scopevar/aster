import { Button } from "@heroui/react";
import type { Bot } from "../../../shared/chat/bots.js";
import { Avatar, Icon } from "../../components/icons.js";
import { LocalMarketEmpty } from "./local-market-empty.js";

export function LocalMarketBots({
  bots,
  query,
  onOpen,
  onNew,
}: {
  bots: Bot[];
  query: string;
  onOpen(id: string): void;
  onNew(): void;
}) {
  const search = query.trim().toLocaleLowerCase();
  const matches = bots.filter((bot) =>
    [bot.name, bot.description, bot.tags].some((text) =>
      text.toLocaleLowerCase().includes(search),
    ),
  );
  if (!matches.length)
    return (
      <LocalMarketEmpty
        icon="bot"
        title={search ? "没有匹配的 Bot" : "还没有本地 Bot"}
      >
        {!search && (
          <>
            <p>新建一个 Bot，或从模板文件导入。</p>
            <Button variant="primary" size="sm" onPress={onNew}>
              新建 Bot
            </Button>
          </>
        )}
      </LocalMarketEmpty>
    );
  return (
    <div className="local-market-grid">
      {matches.map((bot) => (
        <article
          className="local-market-card"
          aria-label={bot.name}
          key={bot.id}
        >
          <Avatar botId={bot.id} appearance={bot.avatar} name={bot.name} />
          <h3>{bot.name}</h3>
          <p>{bot.description || "打开会话，开始使用这个 Bot。"}</p>
          <Button
            variant="secondary"
            size="sm"
            aria-label={"打开会话 " + bot.name}
            onPress={() => onOpen(bot.id)}
          >
            打开会话 <Icon name="chevron" size={14} />
          </Button>
        </article>
      ))}
    </div>
  );
}
