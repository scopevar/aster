import type { PendingMessageView } from "./pending-message.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Attachment } from "../../../shared/files/attachments.js";
import type { Bot } from "../../../shared/chat/bots.js";
import type { CommandResult } from "../../../shared/core.js";
import type { Message } from "../../../shared/chat/messages.js";
import type { Run } from "../../../shared/chat/runs.js";
import { messageActivity } from "./message-activity.js";
import type { SkillSummary } from "../../../shared/tools/skills.js";

export function useMessageList({
  messages,
  pendingMessages,
  retrySend,
  runs,
  hasOlder,
  hasNewer,
  historical,
  focusedMessageId,
  onOlder,
  onNewer,
  onLatest,
  act,
  recentEmojis,
  botName,
  groupBots,
  timeZone,
  onRead,
  onOpenAttachment,
  onReply,
  onOpenSkill,
  onOpenRoutines,
  onOpenTemplates,
  onOpenGroupMember,
}: {
  messages: Message[];
  pendingMessages: PendingMessageView[];
  retrySend(id: string): void;
  runs: Run[];
  hasOlder: boolean;
  hasNewer: boolean;
  historical: boolean;
  focusedMessageId: string | null;
  onOlder(): Promise<void>;
  onNewer(): Promise<void>;
  onLatest(): void;
  act(command: Command): Promise<CommandResult | undefined>;
  recentEmojis: string[];
  botName: string;
  groupBots?: Bot[] | undefined;
  timeZone: string;
  onRead(sequence: number): void;
  onOpenAttachment(file: Attachment): void;
  onReply(message: Message): Promise<void>;
  onOpenSkill(skill: SkillSummary): void;
  onOpenRoutines(botId: string): void;
  onOpenTemplates(id: string): void;
  onOpenGroupMember(id: string): void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    atBottom = useRef(true),
    [menu, setMenu] = useState<{
      id: string;
      anchor: HTMLElement;
      point?: { x: number; y: number };
    } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [pending, setPending] = useState(false);
  const scrollAnchor = useRef<
    | {
        id: string;
        top: number;
      }
    | "bottom"
    | null
  >(null);
  const wasHistorical = useRef(historical);
  const [retrying, setRetrying] = useState<string | null>(null);
  const activity = historical ? null : messageActivity(messages, runs);
  const replied = useRef<{
    runId: string | undefined;
    ordinals: Set<number | null>;
  }>({ runId: undefined, ordinals: new Set() });
  if (replied.current.runId !== activity?.runId)
    replied.current = { runId: activity?.runId, ordinals: new Set() };
  if (activity) {
    if (activity.hasText) replied.current.ordinals.add(activity.ordinal);
    if (replied.current.ordinals.has(activity.ordinal))
      activity.loading = false;
  }
  const workingMember = groupBots?.find(
    (member) => member.id === activity?.botId,
  );
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    if (wasHistorical.current && !historical) {
      scrollAnchor.current = null;
      atBottom.current = true;
    }
    wasHistorical.current = historical;
    const anchor = scrollAnchor.current;
    if (anchor === "bottom") {
      container.scrollTop = container.scrollHeight;
    } else if (anchor) {
      const target = Array.from(
        container.querySelectorAll<HTMLElement>("[data-message-id]"),
      ).find((element) => element.dataset.messageId === anchor.id);
      if (target)
        container.scrollTop += target.getBoundingClientRect().top - anchor.top;
    } else if (!historical && atBottom.current) {
      container.scrollTop = container.scrollHeight;
    }
    if (!pending) scrollAnchor.current = null;
  }, [
    messages,
    historical,
    pendingMessages,
    activity?.loading,
    activity?.ordinal,
    pending,
  ]);
  async function loadPage(direction: "before" | "after") {
    if (pending || !ref.current) return;
    const container = ref.current;
    const top = container.getBoundingClientRect().top;
    const anchor = Array.from(
      container.querySelectorAll<HTMLElement>("[data-message-id]"),
    ).find((element) => element.getBoundingClientRect().bottom > top);
    scrollAnchor.current =
      direction === "after"
        ? "bottom"
        : anchor?.dataset.messageId
          ? {
              id: anchor.dataset.messageId,
              top: anchor.getBoundingClientRect().top,
            }
          : null;
    atBottom.current = false;
    setPending(true);
    try {
      await (direction === "before" ? onOlder() : onNewer());
    } finally {
      setPending(false);
    }
  }
  useLayoutEffect(() => {
    if (!focusedMessageId || !ref.current) return;
    const target = Array.from(
      ref.current.querySelectorAll<HTMLElement>("[data-message-id]"),
    ).find((element) => element.dataset.messageId === focusedMessageId);
    target?.scrollIntoView({ block: "center" });
    atBottom.current = false;
  }, [focusedMessageId, messages]);
  useLayoutEffect(() => {
    const container = ref.current;
    const last = messages.at(-1);
    if (!container) return;
    const check = () => {
      if (
        !historical &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        container.scrollHeight - container.scrollTop - container.clientHeight <=
          2
      )
        onRead(last?.sequence ?? 0);
    };
    check();
    container.addEventListener("scroll", check);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      container.removeEventListener("scroll", check);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [messages, onRead, historical]);
  return {
    messages,
    pendingMessages: pendingMessages.filter(
      (pending) => !messages.some((message) => message.id === pending.id),
    ),
    sendFeedback: new Map(
      pendingMessages.map((message) => [message.id, message]),
    ),
    retrySend,
    runs,
    hasOlder,
    hasNewer,
    historical,
    focusedMessageId,
    onLatest,
    act,
    recentEmojis,
    botName,
    groupBots,
    timeZone,
    onOpenAttachment,
    onReply,
    onOpenSkill,
    onOpenRoutines,
    onOpenTemplates,
    onOpenGroupMember,
    ref,
    atBottom,
    menu,
    setMenu,
    closeMenu,
    pending,
    loadPage,
    retrying,
    setRetrying,
    workingMember,
    activity,
  };
}
export type MessageListViewModel = ReturnType<typeof useMessageList>;
