import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  questionSchema,
  type QuestionInput,
  type QuestionAnswer,
} from "../../shared/chat/questions.js";
import type { Job } from "../store.js";

/** Store owns the transaction including answer consumption and follow-up enqueue. */
export class QuestionStorage {
  constructor(private readonly db: DatabaseSync) {}
  migrate() {
    this.db.exec(`CREATE TABLE questions(
      id TEXT PRIMARY KEY, messageId TEXT UNIQUE NOT NULL REFERENCES messages(id),
      botId TEXT NOT NULL REFERENCES bots(id), conversationId TEXT NOT NULL REFERENCES conversations(id),
      runId TEXT NOT NULL REFERENCES runs(id), ordinal INTEGER NOT NULL, callId TEXT NOT NULL,
      prompt TEXT NOT NULL, optionsJson TEXT NOT NULL, status TEXT NOT NULL,
      answer TEXT, answerRunId TEXT REFERENCES runs(id), UNIQUE(runId,ordinal,callId));
      CREATE INDEX questions_pending ON questions(conversationId,status);`);
  }
  private select =
    "SELECT id,messageId,botId,conversationId,runId,prompt,optionsJson,status,answer,answerRunId FROM questions";
  private parse(value: unknown) {
    const raw = z
      .object({ optionsJson: z.string() })
      .passthrough()
      .parse(value);
    const { optionsJson, ...rest } = raw;
    return questionSchema.parse({ ...rest, options: JSON.parse(optionsJson) });
  }
  get(id: string) {
    const row = this.db.prepare(`${this.select} WHERE id=?`).get(id);
    if (!row) throw new AppError("not_found", "问题不存在。");
    return this.parse(row);
  }
  forMessage(id: string) {
    const row = this.db.prepare(`${this.select} WHERE messageId=?`).get(id);
    return row ? this.parse(row) : null;
  }
  create(job: Job, callId: string, input: QuestionInput) {
    const old = this.db
      .prepare(
        "SELECT id FROM questions WHERE runId=? AND ordinal=? AND callId=?",
      )
      .get(job.id, job.groupOrdinal ?? -1, callId);
    if (old) {
      const question = this.get(z.string().parse(old.id));
      if (
        question.prompt !== input.prompt ||
        JSON.stringify(question.options) !== JSON.stringify(input.options)
      )
        throw new AppError("conflict", "同一问题调用不能改变内容。");
      return question;
    }
    const counts = z
      .object({ runCount: z.number(), pending: z.number() })
      .parse(
        this.db
          .prepare(
            "SELECT (SELECT count(*) FROM questions WHERE runId=?) AS runCount,(SELECT count(*) FROM questions WHERE conversationId=? AND status='pending') AS pending",
          )
          .get(job.id, job.conversationId),
      );
    if (counts.runCount >= 4 || counts.pending >= 16)
      throw new AppError("capacity", "待回答问题过多，请先处理已有问题。");
    const id = randomUUID(),
      messageId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId,itemId) VALUES(?,?,?,'assistant',?,?,?,?)",
      )
      .run(
        messageId,
        job.botId,
        job.conversationId,
        input.prompt,
        Date.now(),
        job.id,
        `question:${id}`,
      );
    this.db
      .prepare(
        "INSERT INTO questions VALUES(?,?,?,?,?,?,?,?,?,'pending',NULL,NULL)",
      )
      .run(
        id,
        messageId,
        job.botId,
        job.conversationId,
        job.id,
        job.groupOrdinal ?? -1,
        callId,
        input.prompt,
        JSON.stringify(input.options),
      );
    return this.get(id);
  }
  resolve(command: QuestionAnswer) {
    const question = this.get(command.id);
    if (question.conversationId !== command.conversationId)
      throw new AppError("unauthorized", "问题不属于这个会话。");
    if (question.status !== "pending")
      throw new AppError("conflict", "这个问题已经处理，不能重复提交。");
    const answer =
      command.answer.type === "skip"
        ? null
        : command.answer.type === "custom"
          ? command.answer.text
          : question.options[command.answer.index];
    if (answer === undefined)
      throw new AppError("invalid_input", "所选答案不属于这个问题。");
    this.db
      .prepare(
        "UPDATE questions SET status=?,answer=? WHERE id=? AND status='pending'",
      )
      .run(answer === null ? "skipped" : "answered", answer, question.id);
    return { ...question, answer };
  }
  attachRun(id: string, runId: string) {
    this.db
      .prepare(
        "UPDATE questions SET answerRunId=? WHERE id=? AND status='answered'",
      )
      .run(runId, id);
  }
  cancelRun(runId: string) {
    this.db
      .prepare(
        "UPDATE questions SET status='cancelled' WHERE runId=? AND status='pending'",
      )
      .run(runId);
  }
}
