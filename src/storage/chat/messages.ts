import type { Job } from "../job.js";
import { skillSchema, type SkillReference } from "../../shared/tools/skills.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import { type Command } from "../../shared/commands.js";
import { type Quote } from "../../shared/chat/conversations.js";
import { maxAttachmentsPerMessage } from "../../shared/files/attachments.js";
import type { SkillStorage } from "../tools/skills.js";
import type { CommandContext } from "../commands/context.js";
import { cancelRun } from "../runs/run-cancellation.js";
type MessageCommandContext = Pick<
  CommandContext,
  | "requestId"
  | "groups"
  | "skills"
  | "skillOwners"
  | "requireConversation"
  | "quote"
  | "getRun"
  | "deletions"
  | "questions"
>;

export class MessageStorage {
  constructor(private readonly db: DatabaseSync) {}
  appendRoutineReceipt(job: Job, messageId: string, text: string) {
    this.db
      .prepare(
        "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId,itemId) VALUES(?,?,?,'assistant',?,?,?,?)",
      )
      .run(
        messageId,
        job.botId,
        job.conversationId,
        text,
        Date.now(),
        job.id,
        `routine:${messageId}`,
      );
  }
  skills(messageId: string) {
    const row = this.db
      .prepare("SELECT skillsJson FROM messages WHERE id=?")
      .get(messageId);
    return z
      .array(skillSchema)
      .max(4)
      .parse(JSON.parse(z.string().parse(row?.skillsJson)));
  }
  frozenSkill(access: SkillReference) {
    const frozen = this.db
      .prepare(
        `SELECT s.value content FROM messages m,json_each(m.skillsJson) s
       WHERE json_extract(s.value,'$.id')=? AND json_extract(s.value,'$.botId')=? AND json_extract(s.value,'$.revision')=? LIMIT 1`,
      )
      .get(access.id, access.botId, access.revision);
    if (!frozen)
      throw new AppError("not_found", "技能版本已删除，且没有保留的共享引用。");
    return skillSchema.parse(JSON.parse(z.string().parse(frozen.content)));
  }
  recover() {
    this.db
      .prepare(
        "UPDATE messages SET toolJson=json_set(toolJson,'$.status','unknown') WHERE json_extract(toolJson,'$.status')='running'",
      )
      .run();
  }
  private activePrivateRun(ctx: MessageCommandContext, conversationId: string) {
    if (ctx.groups.read(conversationId)) return undefined;
    const row = this.db
      .prepare(
        "SELECT id FROM runs WHERE conversationId=? AND status IN ('queued','running') AND cloudRemote=0 ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, createdAt, rowid LIMIT 1",
      )
      .get(conversationId);
    return row ? z.string().parse(row.id) : undefined;
  }
  private insertUserMessage(
    runId: string,
    botId: string,
    command: Extract<Command, { type: "message.send" }>,
    quote: Quote | null,
    skills: ReturnType<SkillStorage["freeze"]>,
    attachmentIds: string[],
    now: number,
    source: "composer" | "question" | "prompt",
    requestId: string | undefined,
  ) {
    const existing = z
      .object({ n: z.number() })
      .parse(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM attachments a JOIN messages m ON m.id=a.messageId WHERE m.runId=? AND m.role='user'",
          )
          .get(runId),
      ).n;
    if (existing + attachmentIds.length > maxAttachmentsPerMessage)
      throw new AppError("capacity", "本次运行附件已达 8 个上限。");
    const messageId =
      source === "composer" ? (requestId ?? randomUUID()) : randomUUID();
    this.db
      .prepare(
        "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId,replyJson) VALUES(?,?,?,'user',?,?,?,?)",
      )
      .run(
        messageId,
        botId,
        command.conversationId,
        command.text,
        now,
        runId,
        quote ? JSON.stringify(quote) : null,
      );
    for (const attachmentId of attachmentIds)
      this.db
        .prepare("UPDATE attachments SET messageId=? WHERE id=?")
        .run(messageId, attachmentId);
    this.db
      .prepare("UPDATE messages SET skillsJson=? WHERE id=?")
      .run(JSON.stringify(skills), messageId);
    if (source === "composer")
      this.db
        .prepare(
          "UPDATE conversations SET draft='',replyToId=NULL,draftSkillsJson='[]' WHERE id=?",
        )
        .run(command.conversationId);
    return messageId;
  }
  enqueueMessage(
    ctx: MessageCommandContext,
    command: Extract<Command, { type: "message.send" }>,
    source: "composer" | "question" | "prompt" = "composer",
  ) {
    const conversation = ctx.requireConversation(command.conversationId);
    if (ctx.groups.read(command.conversationId)?.draft)
      throw new AppError("conflict", "请先从群聊草稿入口发送首条消息。");
    const attachmentIds = command.attachmentIds ?? [];
    const skills = ctx.skills.freeze(
      command.skills ?? [],
      ctx.skillOwners(command.conversationId),
    );
    if (
      !command.text.trim() &&
      attachmentIds.length === 0 &&
      skills.length === 0
    )
      throw new AppError("invalid_input", "请输入消息、添加附件或引用技能。");
    if (new Set(attachmentIds).size !== attachmentIds.length)
      throw new AppError("invalid_input", "附件不能重复附加。");
    for (const attachmentId of attachmentIds) {
      const row = this.db
        .prepare(
          "SELECT id FROM attachments WHERE id=? AND conversationId=? AND messageId IS NULL",
        )
        .get(attachmentId, command.conversationId);
      if (!row)
        throw new AppError("conflict", "附件已移除、已发送或不属于当前会话。");
    }
    const quote = command.replyToId
      ? ctx.quote(command.conversationId, command.replyToId)
      : null;
    const now = Date.now();
    const joined = this.activePrivateRun(ctx, command.conversationId);
    if (joined) {
      this.insertUserMessage(
        joined,
        conversation.botId,
        command,
        quote,
        skills,
        attachmentIds,
        now,
        source,
        ctx.requestId,
      );
      return { id: joined };
    }
    const count = z
      .object({ n: z.number() })
      .parse(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM runs WHERE status IN ('queued','running','cancelling')",
          )
          .get(),
      ).n;
    if (count >= 100)
      throw new AppError("capacity", "等待队列已满，请等待已有任务完成。");
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO runs(id,botId,conversationId,status,createdAt) VALUES(?,?,?,'queued',?)",
      )
      .run(id, conversation.botId, command.conversationId, now);
    const messageId = this.insertUserMessage(
      id,
      conversation.botId,
      command,
      quote,
      skills,
      attachmentIds,
      now,
      source,
      ctx.requestId,
    );
    this.db
      .prepare("UPDATE runs SET inputMessageId=? WHERE id=?")
      .run(messageId, id);
    ctx.groups.plan(command.conversationId, id, command.recipientIds);
    if (source === "composer" && ctx.groups.read(command.conversationId))
      ctx.groups.setRecipients(command.conversationId, []);
    return { id };
  }
  private retryRun(ctx: MessageCommandContext, runId: string) {
    const run = ctx.getRun(runId);
    if (!run) throw new AppError("not_found", "任务已不存在。");
    if (run.groupTurns.length)
      throw new AppError(
        "conflict",
        "群聊失败还不能从原运行重试，请重新发送。",
      );
    if (run.status === "unknown")
      throw new AppError(
        "conflict",
        "结果未知，不会重新发送。请先核实这次运行。",
      );
    if (run.status !== "failed")
      throw new AppError("conflict", "只有失败的运行可以重试。");
    ctx.deletions.botActive(run.botId);
    ctx.deletions.conversationAvailable(run.conversationId);
    const sideEffect = this.db
      .prepare(
        `SELECT 1 AS hit FROM plugin_calls WHERE runId=?
         UNION ALL
         SELECT 1 AS hit FROM messages m
         WHERE m.runId=? AND m.role='assistant' AND (
           m.toolJson IS NOT NULL
           OR EXISTS(SELECT 1 FROM computer_calls c WHERE c.messageId=m.id)
           OR EXISTS(SELECT 1 FROM questions q WHERE q.messageId=m.id)
           OR EXISTS(SELECT 1 FROM document_calls d WHERE d.messageId=m.id)
           OR EXISTS(SELECT 1 FROM routine_tool_calls r WHERE r.messageId=m.id)
           OR EXISTS(SELECT 1 FROM template_tool_calls t WHERE t.messageId=m.id)
           OR EXISTS(SELECT 1 FROM attachments a WHERE a.messageId=m.id)
           OR EXISTS(SELECT 1 FROM memories mem WHERE mem.sourceMessageId=m.id)
           OR EXISTS(SELECT 1 FROM memory_jobs j WHERE j.sourceMessageId=m.id)
         ) LIMIT 1`,
      )
      .get(runId, runId);
    if (sideEffect)
      throw new AppError(
        "conflict",
        "这次失败已经留下工具、问题或文档记录，重试会重复副作用。请核实后另发消息。",
      );
    const count = z
      .object({ n: z.number() })
      .parse(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM runs WHERE status IN ('queued','running','cancelling')",
          )
          .get(),
      ).n;
    if (count >= 100)
      throw new AppError("capacity", "等待队列已满，请等待已有任务完成。");
    this.db
      .prepare(
        "UPDATE conversations SET replyToId=NULL WHERE replyToId IN (SELECT id FROM messages WHERE runId=? AND role='assistant')",
      )
      .run(runId);
    this.db
      .prepare(
        "DELETE FROM reactions WHERE messageId IN (SELECT id FROM messages WHERE runId=? AND role='assistant')",
      )
      .run(runId);
    this.db
      .prepare("DELETE FROM messages WHERE runId=? AND role='assistant'")
      .run(runId);
    this.db
      .prepare("UPDATE messages SET consumed=0 WHERE runId=? AND role='user'")
      .run(runId);
    const updated = this.db
      .prepare(
        "UPDATE runs SET status='queued', error=NULL, turnId=NULL WHERE id=? AND status='failed'",
      )
      .run(runId);
    if (!updated.changes)
      throw new AppError("conflict", "只有失败的运行可以重试。");
    return { id: runId };
  }
  send(
    command: Extract<Command, { type: "message.send" }>,
    ctx: MessageCommandContext,
  ) {
    return this.enqueueMessage(ctx, command);
  }
  prompt(
    command: Extract<Command, { type: "message.prompt" }>,
    ctx: MessageCommandContext,
  ) {
    return this.enqueueMessage(
      ctx,
      { ...command, type: "message.send" },
      "prompt",
    );
  }
  cancel(
    command: Extract<Command, { type: "run.cancel" }>,
    ctx: MessageCommandContext,
  ) {
    cancelRun(this.db, ctx, command.runId);
    return {};
  }
  retry(
    command: Extract<Command, { type: "run.retry" }>,
    ctx: MessageCommandContext,
  ) {
    return this.retryRun(ctx, command.runId);
  }
  react(command: Extract<Command, { type: "reaction.set" }>) {
    if (
      !this.db
        .prepare("SELECT id FROM messages WHERE id=?")
        .get(command.messageId)
    )
      throw new AppError("not_found", "消息已不存在。");
    if (command.active) {
      this.db
        .prepare("INSERT OR IGNORE INTO reactions VALUES(?,'local',?)")
        .run(command.messageId, command.emoji);
      this.db
        .prepare(
          "INSERT INTO recent_emojis VALUES('local',?,(SELECT revision+1 FROM meta WHERE id=1)) ON CONFLICT(userId,emoji) DO UPDATE SET usedOrder=excluded.usedOrder",
        )
        .run(command.emoji);
      this.db
        .prepare(
          "DELETE FROM recent_emojis WHERE userId='local' AND emoji NOT IN (SELECT emoji FROM recent_emojis WHERE userId='local' ORDER BY usedOrder DESC,rowid DESC LIMIT 24)",
        )
        .run();
    } else
      this.db
        .prepare(
          "DELETE FROM reactions WHERE messageId=? AND userId='local' AND emoji=?",
        )
        .run(command.messageId, command.emoji);
    return {};
  }
}
