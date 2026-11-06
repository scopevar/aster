import { Avatar } from "../../components/icons.js";
import type { Bot } from "../../../shared/chat/bots.js";
import "./message-activity.css";

export function ReplyLoading({
  name,
  member,
}: {
  name: string;
  member?: Bot | undefined;
}) {
  return (
    <article
      className="message assistant reply-loading"
      role="status"
      aria-label={`${name} 正在回复`}
    >
      {member && (
        <div className="reply-loading-sender">
          <Avatar
            small
            botId={member.id}
            appearance={member.avatar}
            name={member.name}
          />
          <span>{name}</span>
        </div>
      )}
      <div className="reply-loading-indicator" aria-hidden="true">
        <span className="loading-dots">
          <span />
          <span />
          <span />
        </span>
        <span>正在回复</span>
      </div>
    </article>
  );
}
