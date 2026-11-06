import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  templateDraftSchema,
  localTemplatesSchema,
  type TemplatePayload,
  type TemplateCommand,
} from "../../shared/templates/templates.js";

/** Legacy publication tables remain readable in backups but have no active outbox. */
export class TemplateStorage {
  constructor(private readonly db: DatabaseSync) {}
  migrate() {
    this.db.exec(`
    CREATE TABLE template_drafts(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payloadJson TEXT NOT NULL,publishedRevision INTEGER NOT NULL DEFAULT 0,publishedStatus TEXT NOT NULL DEFAULT 'unpublished',updatedAt INTEGER NOT NULL);
    CREATE TABLE template_jobs(id TEXT PRIMARY KEY,templateId TEXT NOT NULL REFERENCES template_drafts(id),status TEXT NOT NULL,requestJson TEXT NOT NULL,error TEXT,createdAt INTEGER NOT NULL);
    CREATE TABLE template_imports(requestId TEXT PRIMARY KEY,serviceId TEXT NOT NULL,templateId TEXT NOT NULL,revision INTEGER NOT NULL,hash TEXT NOT NULL,botId TEXT NOT NULL REFERENCES bots(id));
  `);
  }
  private capacity(bytes: number) {
    const size = Number(
      this.db
        .prepare(
          "SELECT (SELECT coalesce(sum(length(CAST(payloadJson AS BLOB))),0) FROM template_drafts)+(SELECT coalesce(sum(length(CAST(requestJson AS BLOB))),0) FROM template_jobs) n",
        )
        .get()?.n,
    );
    if (size + bytes > 64 * 1024 * 1024)
      throw new AppError(
        "capacity",
        "本地模板草稿与提交记录达到 64 MiB 上限。",
      );
  }
  create(payload: TemplatePayload) {
    if (
      Number(
        this.db.prepare("SELECT count(*) n FROM template_drafts").get()?.n,
      ) >= 100
    )
      throw new AppError("capacity", "本地模板草稿达到 100 项上限。");
    const id = randomUUID(),
      json = JSON.stringify(payload);
    this.capacity(Buffer.byteLength(json));
    this.db
      .prepare(
        "INSERT INTO template_drafts(id,revision,payloadJson,updatedAt) VALUES(?,1,?,?)",
      )
      .run(id, json, Date.now());
    return { id, revision: 1 };
  }
  read(id: string) {
    const row = this.db
      .prepare("SELECT * FROM template_drafts WHERE id=?")
      .get(id);
    if (!row) throw new AppError("not_found", "模板草稿不存在。");
    return templateDraftSchema.parse({
      ...row,
      payload: JSON.parse(z.string().parse(row.payloadJson)),
    });
  }
  view() {
    return localTemplatesSchema.parse({
      drafts: this.db
        .prepare(
          "SELECT id,revision,updatedAt,json_extract(payloadJson,'$.name') name,json_extract(payloadJson,'$.description') description FROM template_drafts ORDER BY updatedAt DESC,id",
        )
        .all(),
    });
  }
  execute(
    command: Exclude<
      TemplateCommand,
      { type: "template.create" | "template.import" }
    >,
  ) {
    if (command.type === "template.save") {
      const draft = this.read(command.id);
      this.capacity(
        Buffer.byteLength(JSON.stringify(command.payload)) -
          Buffer.byteLength(JSON.stringify(draft.payload)),
      );
      const changed = this.db
        .prepare(
          "UPDATE template_drafts SET revision=revision+1,payloadJson=?,updatedAt=? WHERE id=? AND revision=?",
        )
        .run(
          JSON.stringify(command.payload),
          Date.now(),
          command.id,
          command.revision,
        );
      if (!changed.changes)
        throw new AppError(
          "conflict",
          "模板草稿已改变，请重新读取；未保存输入仍可保留。",
        );
      return { id: command.id, revision: command.revision + 1 };
    }
    const draft = this.read(command.id);
    if (draft.revision !== command.revision)
      throw new AppError("conflict", "模板已改变，请重新读取后删除。");
    this.db
      .prepare("DELETE FROM template_jobs WHERE templateId=?")
      .run(draft.id);
    this.db.prepare("DELETE FROM template_drafts WHERE id=?").run(draft.id);
    return { id: draft.id };
  }
}
