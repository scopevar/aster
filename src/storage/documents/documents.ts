import type { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  documentCallSchema,
  documentResultSchema,
  documentSummarySchema,
  type DocumentOperation,
  type DocumentResult,
} from "../../shared/files/documents.js";
import type { Job } from "../store.js";

/** Store owns transactions and validates the live run before entry and before committing results. */
export class DocumentStorage {
  constructor(private readonly db: DatabaseSync) {}
  migrate() {
    this.db.exec(`
      CREATE TABLE attachments_pdf(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','image','pdf')), mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0 AND size<=26214400), hash TEXT NOT NULL, createdAt INTEGER NOT NULL, messageId TEXT REFERENCES messages(id), data BLOB NOT NULL);
      INSERT INTO attachments_pdf SELECT * FROM attachments;
      DROP TABLE attachments;
      ALTER TABLE attachments_pdf RENAME TO attachments;
      CREATE INDEX attachment_draft ON attachments(conversationId,messageId);
      CREATE TRIGGER attachment_message_scope BEFORE UPDATE OF messageId ON attachments WHEN NEW.messageId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM messages WHERE id=NEW.messageId AND conversationId=NEW.conversationId) BEGIN SELECT RAISE(ABORT,'attachment scope mismatch'); END;
      CREATE TABLE document_calls(id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, callId TEXT NOT NULL, fingerprint TEXT NOT NULL, messageId TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE, attachmentId TEXT REFERENCES attachments(id) ON DELETE SET NULL, action TEXT NOT NULL, page INTEGER, name TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, resultJson TEXT, UNIQUE(runId,ordinal,callId));
    `);
  }
  migrateOffice() {
    // Preserve call references before replacing the parent table: ON DELETE SET NULL would otherwise erase them.
    this.db.exec(`
      CREATE TEMP TABLE document_calls_office AS SELECT * FROM document_calls;
      DROP TABLE document_calls;
      CREATE TABLE attachments_office(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','image','pdf','docx','table')), mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0 AND size<=26214400), hash TEXT NOT NULL, createdAt INTEGER NOT NULL, messageId TEXT REFERENCES messages(id), data BLOB NOT NULL);
      INSERT INTO attachments_office SELECT * FROM attachments;
      DROP TABLE attachments;
      ALTER TABLE attachments_office RENAME TO attachments;
      CREATE INDEX attachment_draft ON attachments(conversationId,messageId);
      CREATE TRIGGER attachment_message_scope BEFORE UPDATE OF messageId ON attachments WHEN NEW.messageId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM messages WHERE id=NEW.messageId AND conversationId=NEW.conversationId) BEGIN SELECT RAISE(ABORT,'attachment scope mismatch'); END;
      CREATE TABLE document_calls(id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, callId TEXT NOT NULL, fingerprint TEXT NOT NULL, messageId TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE, attachmentId TEXT REFERENCES attachments(id) ON DELETE SET NULL, action TEXT NOT NULL, page INTEGER, name TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, resultJson TEXT, UNIQUE(runId,ordinal,callId));
      INSERT INTO document_calls SELECT * FROM document_calls_office;
      DROP TABLE document_calls_office;
    `);
  }

  private allowed(job: Job) {
    if (job.groupOrdinal === undefined)
      return {
        condition: `m.sequence <= (SELECT sequence FROM messages WHERE id=(SELECT inputMessageId FROM runs WHERE id=?))`,
        args: [job.id],
      };
    return {
      condition: `(EXISTS(SELECT 1 FROM group_context c WHERE c.conversationId=m.conversationId AND c.botId=? AND c.messageId=m.id) OR EXISTS(SELECT 1 FROM group_turn_context c WHERE c.runId=? AND c.ordinal=? AND c.messageId=m.id))`,
      args: [job.botId, job.id, job.groupOrdinal],
    };
  }

  list(job: Job, after?: string): Extract<DocumentResult, { action: "list" }> {
    const allowed = this.allowed(job);
    const rows = this.db
      .prepare(
        `SELECT a.id,a.kind,a.name,a.size FROM attachments a JOIN messages m ON m.id=a.messageId WHERE a.conversationId=? AND a.kind IN ('pdf','docx','table','video') AND ${allowed.condition} AND a.id>? ORDER BY a.id LIMIT 33`,
      )
      .all(job.conversationId, ...allowed.args, after ?? "");
    const documents = rows
      .slice(0, 32)
      .map((row) => documentSummarySchema.parse(row));
    return {
      action: "list",
      documents,
      next: rows.length > 32 ? (documents.at(-1)?.id ?? null) : null,
    };
  }

  content(job: Job, id: string) {
    const allowed = this.allowed(job);
    const row = this.db
      .prepare(
        `SELECT a.id,a.kind,a.name,a.size,a.hash,a.data FROM attachments a JOIN messages m ON m.id=a.messageId WHERE a.id=? AND a.conversationId=? AND a.kind IN ('pdf','docx','table','video') AND ${allowed.condition}`,
      )
      .get(id, job.conversationId, ...allowed.args);
    if (!row)
      throw new AppError(
        "unauthorized",
        "此文档未向当前运行明确共享，或文件已删除。",
      );
    const file = z
      .object({
        id: z.uuid(),
        kind: z.enum(["pdf", "docx", "table", "video"]),
        name: z.string(),
        size: z.number(),
        hash: z.string(),
        data: z.instanceof(Uint8Array),
      })
      .parse(row);
    if (
      file.data.byteLength !== file.size ||
      createHash("sha256").update(file.data).digest("hex") !== file.hash
    )
      throw new AppError(
        "unavailable",
        "文档内容完整性检查失败，请从备份恢复。",
      );
    return file;
  }

  begin(job: Job, callId: string, operation: DocumentOperation) {
    const ordinal = job.groupOrdinal ?? -1;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(operation))
      .digest("hex");
    const old = this.db
      .prepare(
        "SELECT id,fingerprint,status,detail,resultJson FROM document_calls WHERE runId=? AND ordinal=? AND callId=?",
      )
      .get(job.id, ordinal, callId);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new AppError("conflict", "同一文档调用编号不能改变参数。");
      if (old.status !== "completed" || !old.resultJson)
        throw new AppError(
          "conflict",
          z.string().parse(old.detail) || "此读取仍在执行，请核实状态后重试。",
        );
      return {
        id: z.string().parse(old.id),
        cached: documentResultSchema.parse(
          JSON.parse(z.string().parse(old.resultJson)),
        ),
      };
    }
    if (
      Number(
        this.db
          .prepare("SELECT count(*) n FROM document_calls WHERE runId=?")
          .get(job.id)?.n,
      ) >= 24
    )
      throw new AppError(
        "capacity",
        "本轮文档读取已达 24 次上限，请在下一条消息中继续。",
      );
    const document =
      operation.action === "list" ? null : this.content(job, operation.id);
    const id = randomUUID(),
      messageId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId,itemId) VALUES(?,?,?,'assistant','',?,?,?)",
      )
      .run(
        messageId,
        job.botId,
        job.conversationId,
        Date.now(),
        job.id,
        `document:${id}`,
      );
    this.db
      .prepare(
        "INSERT INTO document_calls(id,runId,ordinal,callId,fingerprint,messageId,attachmentId,action,page,name,status,detail) VALUES(?,?,?,?,?,?,?,?,?,?,'running','正在读取文档…')",
      )
      .run(
        id,
        job.id,
        ordinal,
        callId,
        fingerprint,
        messageId,
        document?.id ?? null,
        operation.action,
        "page" in operation ? operation.page : null,
        document?.name ?? "文档附件目录",
      );
    this.syncMessage(id);
    return { id, cached: null };
  }

  complete(id: string, result: DocumentResult) {
    const value = JSON.stringify(documentResultSchema.parse(result));
    const size = Number(
      this.db
        .prepare(
          "SELECT coalesce(sum(length(CAST(resultJson AS BLOB))),0) n FROM document_calls WHERE runId=(SELECT runId FROM document_calls WHERE id=?)",
        )
        .get(id)?.n,
    );
    if (size + Buffer.byteLength(value) > 20 * 1024 * 1024)
      throw new AppError(
        "capacity",
        "本轮文档结果超过 20 MiB，请在下一条消息中继续。",
      );
    const detail =
      result.action === "list"
        ? `找到 ${result.documents.length} 个文档${result.next ? "，还有下一页目录" : ""}`
        : result.action === "info"
          ? `共 ${result.pages} 页`
          : result.action === "text" || result.action === "render"
            ? `已读取第 ${result.page} / ${result.pages} 页${result.action === "text" && !result.text ? "；此页没有可提取文字，请查看页面图片" : ""}`
            : result.action === "word.info"
              ? `共 ${result.characters} 字符、${result.images} 张图片`
              : result.action === "word.text"
                ? `已读取第 ${result.offset + 1} 至 ${result.offset + result.text.length} 字符，共 ${result.total} 字符`
                : result.action === "word.image"
                  ? (result.image.error ??
                    `已读取图片 ${result.image.index + 1}`)
                  : result.action === "table.info"
                    ? `共 ${result.sheets.length} 张工作表`
                    : result.action === "table.range"
                      ? `已读取 ${result.sheet.name} 第 ${result.row} 行、第 ${result.column} 列起的 ${result.cells.length} 行`
                      : result.action === "video.info"
                        ? `${result.width} × ${result.height}，${result.durationMs === null ? "时长未知" : `时长 ${result.durationMs} 毫秒`}${result.hasAudio ? "；音轨未转写" : ""}`
                        : result.action === "video.frame"
                          ? `已读取 ${result.requestedMs} 毫秒处的画面`
                          : "已读取文档结构";
    const saved = this.db
      .prepare(
        "UPDATE document_calls SET status='completed',detail=?,resultJson=? WHERE id=? AND status='running'",
      )
      .run(detail, value, id);
    if (saved.changes !== 1)
      throw new AppError("conflict", "文档读取已被取消或结束。");
    this.syncMessage(id);
  }

  end(id: string, detail: string, cancelled: boolean) {
    this.db
      .prepare(
        "UPDATE document_calls SET status=?,detail=? WHERE id=? AND status='running'",
      )
      .run(cancelled ? "cancelled" : "failed", detail.slice(0, 1000), id);
    this.syncMessage(id);
  }
  recover() {
    const interrupted = this.db
      .prepare("SELECT id FROM document_calls WHERE status='running'")
      .all();
    this.db
      .prepare(
        "UPDATE document_calls SET status='failed',detail='上次读取中断，未自动重放。请重新请求读取。' WHERE status='running'",
      )
      .run();
    for (const row of interrupted) this.syncMessage(z.string().parse(row.id));
    this.db
      .prepare(
        "UPDATE document_calls SET resultJson=NULL WHERE runId IN(SELECT id FROM runs WHERE status NOT IN('running','cancelling'))",
      )
      .run();
  }
  finishRun(runId: string) {
    const interrupted = this.db
      .prepare(
        "SELECT id FROM document_calls WHERE runId=? AND status='running'",
      )
      .all(runId);
    for (const row of interrupted)
      this.end(
        z.string().parse(row.id),
        "所属运行已结束，未确认此读取完成。",
        false,
      );
    // Results only support reconnect deduplication while this run owns a tool scope.
    // Keep the visible audit metadata, not an unbounded history of derived image bytes.
    this.db
      .prepare("UPDATE document_calls SET resultJson=NULL WHERE runId=?")
      .run(runId);
  }
  private syncMessage(id: string) {
    this.db
      .prepare(
        "UPDATE messages SET text=(SELECT '文档：'||name||' — '||detail FROM document_calls WHERE id=?) WHERE id=(SELECT messageId FROM document_calls WHERE id=?)",
      )
      .run(id, id);
  }
  forMessage(messageId: string) {
    const row = this.db
      .prepare(
        "SELECT id,attachmentId,action,page,name,status,detail FROM document_calls WHERE messageId=?",
      )
      .get(messageId);
    return row ? documentCallSchema.parse(row) : null;
  }
}
