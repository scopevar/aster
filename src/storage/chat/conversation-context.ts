import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import type { Job } from "../job.js";

/** Retained schema preserves historical summaries in existing databases and backups. */
export function migrateConversationContext(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE conversation_context(conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,threadId TEXT,estimatedTokens INTEGER NOT NULL DEFAULT 0,contextWindow INTEGER,turns INTEGER NOT NULL DEFAULT 0,summary TEXT NOT NULL DEFAULT '',tailJson TEXT NOT NULL DEFAULT '',throughSequence INTEGER NOT NULL DEFAULT 0,pendingRestart INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(conversationId,botId));
    CREATE TABLE context_checkpoints(id INTEGER PRIMARY KEY,conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,threadId TEXT,summary TEXT NOT NULL,tailJson TEXT NOT NULL,throughSequence INTEGER NOT NULL,createdAt INTEGER NOT NULL);
  `);
}
export class ConversationContextStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: {
      transaction<T>(fn: () => T): T;
      canWrite(job: Job): boolean;
    },
  ) {}
  legacy(job: Job) {
    if (!this.owner.canWrite(job))
      throw new AppError("unauthorized", "历史交接授权已结束。");
    const row =
      this.db
        .prepare(
          "SELECT summary,tailJson FROM conversation_context WHERE conversationId=? AND botId=?",
        )
        .get(job.conversationId, job.botId) ??
      this.db
        .prepare(
          "SELECT summary,tailJson FROM context_checkpoints WHERE conversationId=? AND botId=? ORDER BY id DESC LIMIT 1",
        )
        .get(job.conversationId, job.botId);
    return row
      ? z
          .object({
            summary: z.string().max(12000),
            tailJson: z.string().max(8000),
          })
          .parse(row)
      : null;
  }
}
