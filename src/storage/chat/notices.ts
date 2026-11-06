import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../../shared/core.js";

/**
 * A completed run that exists only to carry one bot-authored message into the
 * user's visible private chat. It is never claimed by the runtime.
 */
export class UserNoticeStorage {
  constructor(private readonly db: DatabaseSync) {}
  private conversation(botId: string) {
    const row = this.db
      .prepare(
        `SELECT c.id FROM conversations c
         WHERE c.botId=? AND c.hidden=0
         AND NOT EXISTS(SELECT 1 FROM groups g WHERE g.conversationId=c.id)
         ORDER BY c.rowid LIMIT 1`,
      )
      .get(botId);
    if (row) return z.string().parse(row.id);
    if (!this.db.prepare("SELECT 1 FROM bots WHERE id=?").get(botId))
      throw new AppError("not_found", "Bot 已不存在。");
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO conversations(id,botId,hidden,createdAt) VALUES(?,?,0,?)",
      )
      .run(id, botId, Date.now());
    return id;
  }
  append(botId: string, text: string, itemId: string, now = Date.now()) {
    const old = this.db
      .prepare(
        "SELECT id,conversationId FROM messages WHERE itemId=? AND role='assistant' LIMIT 1",
      )
      .get(itemId);
    if (old)
      return {
        messageId: z.string().parse(old.id),
        conversationId: z.string().parse(old.conversationId),
      };
    const conversationId = this.conversation(botId);
    const runId = randomUUID(),
      messageId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO runs(id,botId,conversationId,status,createdAt) VALUES(?,?,?,'completed',?)",
      )
      .run(runId, botId, conversationId, now);
    this.db
      .prepare(
        "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId,itemId) VALUES(?,?,?,'assistant',?,?,?,?)",
      )
      .run(messageId, botId, conversationId, text, now, runId, itemId);
    return { messageId, conversationId };
  }
}
