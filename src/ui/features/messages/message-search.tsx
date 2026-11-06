import { Input, Button } from "@heroui/react";
import { useRef, useState } from "react";
import type { Bot } from "../../../shared/chat/bots.js";
import type { Conversation } from "../../../shared/chat/conversations.js";
import type { MessageSearchHit } from "../../../shared/chat/message-search.js";
import { messageSearch, errorMessage } from "../../lib/client.js";
import { Modal } from "../../components/modal.js";
import "./message-search.css";

export function MessageSearch({
  bots,
  conversations,
  onClose,
  onJump,
}: {
  bots: Bot[];
  conversations: Conversation[];
  onClose(): void;
  onJump(hit: MessageSearchHit): Promise<void>;
}) {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [hits, setHits] = useState<MessageSearchHit[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [scanned, setScanned] = useState(0);
  const [busy, setBusy] = useState(false);
  const [jumping, setJumping] = useState<string | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const search = async (term: string, before?: number) => {
    const id = ++generation.current;
    setBusy(true);
    setError("");
    if (!before) {
      setSubmitted(term);
      setHits([]);
      setNextBefore(null);
      setScanned(0);
    }
    try {
      const page = await messageSearch({
        version: 1,
        text: term,
        ...(before ? { before } : {}),
      });
      if (id !== generation.current) return;
      setHits((current) =>
        before ? [...current, ...page.hits].slice(-200) : page.hits,
      );
      setNextBefore(page.nextBefore);
      setScanned((current) => (before ? current + page.scanned : page.scanned));
    } catch (cause) {
      if (id === generation.current) setError(errorMessage(cause));
    } finally {
      if (id === generation.current) setBusy(false);
    }
  };
  const close = () => {
    generation.current++;
    onClose();
  };
  return (
    <Modal title="搜索消息" onClose={close} wide>
      <div className="message-search">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim() || busy || jumping) return;
            void search(text.trim());
          }}
        >
          <Input
            variant="secondary"
            aria-label="消息关键词"
            value={text}
            maxLength={160}
            placeholder="搜索已保存的消息文本"
            onChange={(event) => {
              generation.current++;
              setText(event.target.value);
              setSubmitted("");
              setHits([]);
              setNextBefore(null);
              setScanned(0);
              setBusy(false);
            }}
          />
          <Button
            variant="primary"
            size="sm"
            className="primary"
            type="submit"
            isDisabled={!text.trim() || busy || !!jumping}
          >
            搜索
          </Button>
        </form>
        <p className="search-scope">
          跨会话查找已保存的消息正文；不搜索附件、工具输出或草稿。
        </p>
        {error && (
          <p role="alert" className="search-error">
            {error}
          </p>
        )}
        {busy && <p role="status">正在查找…</p>}
        {submitted && !busy && (
          <p role="status">
            已扫描 {scanned} 条消息，找到 {hits.length} 条
            {nextBefore ? "；更早的消息可继续查找" : ""}。
          </p>
        )}
        <div className="message-search-results" aria-label="消息搜索结果">
          {hits.map((hit) => {
            const conversation = conversations.find(
              (item) => item.id === hit.conversationId,
            );
            const bot = bots.find((item) => item.id === conversation?.botId);
            return (
              <Button
                variant="ghost"
                size="sm"
                key={hit.messageId}
                isDisabled={!!jumping || !!conversation?.deletionPending}
                onClick={() => {
                  setJumping(hit.messageId);
                  setError("");
                  void onJump(hit)
                    .then(close, (cause) => setError(errorMessage(cause)))
                    .finally(() => setJumping(null));
                }}
              >
                <span className="search-result-title">
                  {conversation?.group?.name ?? bot?.name ?? "会话已不可用"} ·{" "}
                  {hit.role === "user" ? "我" : "Bot"} ·{" "}
                  {new Date(hit.createdAt).toLocaleString("zh-CN")}
                </span>
                <span className="search-result-excerpt">{hit.excerpt}</span>
              </Button>
            );
          })}
        </div>
        {nextBefore && (
          <Button
            variant="secondary"
            size="sm"
            className="secondary"
            isDisabled={busy || !!jumping}
            onClick={() => void search(submitted, nextBefore)}
          >
            继续查找更早消息
          </Button>
        )}
      </div>
    </Modal>
  );
}
