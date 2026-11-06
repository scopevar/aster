import type { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  templateReceiptSchema,
  templateToolResultSchema,
  type TemplateOperation,
  type TemplateReceipt,
  type TemplateToolResult,
} from "../../shared/templates/template-tools.js";
import type { TemplatePayload } from "../../shared/templates/templates.js";
import type { TemplateStorage } from "./templates.js";
import type { Job } from "../store.js";

/** Store owns the surrounding transaction and checks the current run generation. */
export class TemplateToolStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly drafts: TemplateStorage,
  ) {}
  migrate() {
    this.db.exec(`
      CREATE TABLE template_owners(templateId TEXT PRIMARY KEY REFERENCES template_drafts(id) ON DELETE CASCADE,botId TEXT NOT NULL REFERENCES bots(id));
      CREATE INDEX template_owner_bot ON template_owners(botId);
      CREATE TABLE template_tool_calls(runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,callId TEXT NOT NULL,fingerprint TEXT NOT NULL,resultJson TEXT NOT NULL,messageId TEXT REFERENCES messages(id) ON DELETE CASCADE,receiptJson TEXT,PRIMARY KEY(runId,callId));
    `);
  }
  own(templateId: string, botId: string) {
    this.db
      .prepare("INSERT INTO template_owners VALUES(?,?)")
      .run(templateId, botId);
  }
  receipt(messageId: string) {
    const row = this.db
      .prepare("SELECT receiptJson FROM template_tool_calls WHERE messageId=?")
      .get(messageId);
    return row
      ? templateReceiptSchema.parse(
          JSON.parse(z.string().parse(row.receiptJson)),
        )
      : null;
  }
  request(
    job: Job,
    callId: string,
    operation: TemplateOperation,
    capture: (skills: boolean, routines: boolean) => TemplatePayload,
  ): TemplateToolResult {
    if (
      job.groupOrdinal !== undefined ||
      this.db.prepare("SELECT 1 FROM routine_events WHERE runId=?").get(job.id)
    )
      throw new AppError(
        "unauthorized",
        "模板工具仅供用户发起的 Bot 私聊使用。",
      );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(operation))
      .digest("hex");
    const previous = this.db
      .prepare(
        "SELECT fingerprint,resultJson FROM template_tool_calls WHERE runId=? AND callId=?",
      )
      .get(job.id, callId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError("conflict", "同一模板调用不能改变参数。");
      return templateToolResultSchema.parse(
        JSON.parse(z.string().parse(previous.resultJson)),
      );
    }
    if (
      Number(
        this.db
          .prepare("SELECT count(*) n FROM template_tool_calls WHERE runId=?")
          .get(job.id)?.n,
      ) >= 24
    )
      throw new AppError("capacity", "每回合最多 24 次模板工具调用。");
    let result: TemplateToolResult,
      receipt: TemplateReceipt | null = null,
      messageId: string | null = null;
    if (operation.action === "list") {
      const ids = new Set(
        this.db
          .prepare("SELECT templateId FROM template_owners WHERE botId=?")
          .all(job.botId)
          .map((row) => row.templateId),
      );
      result = {
        action: "list",
        drafts: this.drafts.view().drafts.filter((draft) => ids.has(draft.id)),
      };
    } else {
      if (
        operation.action !== "create" &&
        this.db
          .prepare("SELECT botId FROM template_owners WHERE templateId=?")
          .get(operation.id)?.botId !== job.botId
      )
        throw new AppError("unauthorized", "模板草稿不属于当前 Bot。");
      if (operation.action === "read")
        result = { action: "read", draft: this.drafts.read(operation.id) };
      else {
        let id: string;
        if (operation.action === "create") {
          const payload = capture(
            operation.includeSkills,
            operation.includeRoutines,
          );
          id = this.drafts.create({
            ...payload,
            name: operation.name,
            description: operation.description,
            tags: operation.tags,
          }).id;
          this.own(id, job.botId);
        } else {
          id = operation.id;
          const draft = this.drafts.read(id);
          this.drafts.execute({
            type: "template.save",
            id,
            revision: operation.revision,
            payload: {
              ...draft.payload,
              name: operation.name,
              description: operation.description,
              tags: operation.tags,
            },
          });
        }
        const draft = this.drafts.read(id);
        receipt = templateReceiptSchema.parse({
          action: operation.action,
          id,
          revision: draft.revision,
          name: draft.payload.name,
          description: draft.payload.description,
          tags: draft.payload.tags,
          image: draft.payload.avatar.image,
          appearance: {
            shape: draft.payload.avatar.shape,
            color: draft.payload.avatar.color,
          },
        });
        messageId = randomUUID();
        this.db
          .prepare(
            "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId,itemId) VALUES(?,?,?,'assistant',?,?,?,?)",
          )
          .run(
            messageId,
            job.botId,
            job.conversationId,
            `${operation.action === "create" ? "已创建" : "已更新"}模板草稿：${receipt.name}`,
            Date.now(),
            job.id,
            `template:${messageId}`,
          );
        result = { action: operation.action, receipt, messageId };
      }
    }
    const checked = templateToolResultSchema.parse(result),
      json = JSON.stringify(checked),
      receiptJson = receipt ? JSON.stringify(receipt) : null;
    const size = Number(
      this.db
        .prepare(
          "SELECT coalesce(sum(length(CAST(resultJson AS BLOB))+coalesce(length(CAST(receiptJson AS BLOB)),0)),0) n FROM template_tool_calls",
        )
        .get()?.n,
    );
    if (
      size + Buffer.byteLength(json) + Buffer.byteLength(receiptJson ?? "") >
      64 * 1024 * 1024
    )
      throw new AppError("capacity", "模板工具审计达到 64 MiB，修改未提交。");
    this.db
      .prepare("INSERT INTO template_tool_calls VALUES(?,?,?,?,?,?)")
      .run(job.id, callId, fingerprint, json, messageId, receiptJson);
    return checked;
  }
}
