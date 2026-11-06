import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  historyResultSchema,
  type HistoryOperation,
} from "../../shared/chat/history.js";
import type { Attachment } from "../../shared/files/attachments.js";
import type { Job } from "../store.js";

/** Store checks the live job before entry. Only older runs from this conversation are visible. */
export class HistoryStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly content: (
      conversationId: string,
      messageId: string,
    ) => { text: string; attachments: Attachment[] },
  ) {}
  private readonly scope =
    "m.conversationId=? AND r.rowid<(SELECT rowid FROM runs WHERE id=?)";
  private readonly select =
    "SELECT m.id,m.sequence,m.role,m.botId,m.createdAt,r.status AS runStatus,substr(m.text,1,240) preview FROM messages m JOIN runs r ON r.id=m.runId";
  hasPrevious(job: Job) {
    return !!this.db
      .prepare(
        `SELECT 1 FROM messages m JOIN runs r ON r.id=m.runId WHERE ${this.scope} LIMIT 1`,
      )
      .get(job.conversationId, job.id);
  }
  read(job: Job, operation: HistoryOperation) {
    if (operation.action === "read") {
      const row = this.db
        .prepare(`${this.select} WHERE ${this.scope} AND m.id=?`)
        .get(job.conversationId, job.id, operation.id);
      if (!row)
        throw new AppError("not_found", "消息不属于当前可读历史，或已被移除。");
      const content = this.content(job.conversationId, operation.id);
      if (operation.offset > content.text.length)
        throw new AppError("invalid_input", "正文读取位置超过消息长度。");
      const text = content.text.slice(
        operation.offset,
        operation.offset + 16384,
      );
      const next = operation.offset + text.length;
      return historyResultSchema.parse({
        action: "read",
        message: {
          ...row,
          preview: z.string().parse(row.preview).slice(0, 240),
        },
        text,
        offset: operation.offset,
        nextOffset: next < content.text.length ? next : null,
        totalCharacters: content.text.length,
        attachments: content.attachments,
      });
    }
    const rows = this.db
      .prepare(
        `${this.select} WHERE ${this.scope} AND m.sequence<? ${operation.action === "search" ? "AND instr(lower(m.text),lower(?))>0" : ""} ORDER BY m.sequence DESC LIMIT ?`,
      )
      .all(
        job.conversationId,
        job.id,
        operation.before ?? Number.MAX_SAFE_INTEGER,
        ...(operation.action === "search" ? [operation.query] : []),
        operation.limit + 1,
      );
    const messages = rows.slice(0, operation.limit).map((row) => ({
      ...row,
      preview: z.string().parse(row.preview).slice(0, 240),
    }));
    return historyResultSchema.parse({
      action: operation.action,
      messages,
      nextBefore:
        rows.length > operation.limit
          ? z.number().parse(rows[operation.limit - 1]?.sequence)
          : null,
    });
  }
}
