import type { Attachment } from "../../../shared/files/attachments.js";
import type { Quote } from "../../../shared/chat/conversations.js";
import type { SkillSummary } from "../../../shared/tools/skills.js";
import { MessageMarkdown } from "./message-markdown.js";
import { MessageSendStatus } from "./message-send-status.js";
import "./message-activity.css";

export type PendingMessageView = {
  id: string;
  text: string;
  replyTo: Quote | null;
  attachments: Attachment[];
  skills: SkillSummary[];
  status: "sending" | "confirmed" | "failed" | "unknown";
  startedAt?: number | undefined;
  error: string;
};

export function PendingMessage({
  message,
  onRetry,
}: {
  message: PendingMessageView;
  onRetry(): void;
}) {
  return (
    <article
      className="message user new-speaker pending-message"
      data-pending-id={message.id}
      aria-label="待确认的消息"
    >
      <div className="message-body">
        <MessageSendStatus
          status={message.status}
          startedAt={message.startedAt}
          error={message.error}
          onRetry={onRetry}
        />
        {message.skills.length > 0 && (
          <div className="skill-chips">
            {message.skills.map((skill) => (
              <span className="skill-chip" key={skill.id}>
                {skill.name} · v{skill.revision}
              </span>
            ))}
          </div>
        )}
        {message.attachments.map((file) => (
          <div className="bubble" key={file.id}>
            {file.name}
          </div>
        ))}
        {message.replyTo && (
          <blockquote className="message-quote">
            {message.replyTo.text}
          </blockquote>
        )}
        {message.text && (
          <div className="bubble message-text">
            <MessageMarkdown text={message.text} />
          </div>
        )}
      </div>
    </article>
  );
}
