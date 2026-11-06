import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import { skillReferencesSchema } from "../../shared/tools/skills.js";
import type { CommandContext } from "../commands/context.js";
import type { Command } from "../../shared/commands.js";
type ConversationCommandContext = Pick<
  CommandContext,
  | "requireBot"
  | "requireConversation"
  | "createConversation"
  | "canonicalPath"
  | "quote"
  | "skills"
  | "skillOwners"
>;

export class ConversationStorage {
  constructor(private readonly db: DatabaseSync) {}
  require(id: string) {
    const row = this.db
      .prepare("SELECT botId FROM conversations WHERE id=?")
      .get(id);
    if (!row) throw new AppError("not_found", "会话已不存在。");
    return z.object({ botId: z.string() }).parse(row);
  }
  createForBot(botId: string, hidden = false) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO conversations(id,botId,hidden,createdAt) VALUES(?,?,?,?)",
      )
      .run(id, botId, Number(hidden), Date.now());
    return id;
  }
  private attachDirectory(
    ctx: ConversationCommandContext,
    conversationId: string,
    root: string,
  ) {
    ctx.requireConversation(conversationId);
    let stat;
    try {
      stat = lstatSync(root);
    } catch {
      throw new AppError("not_found", "找不到要授权的目录。");
    }
    if (stat.isSymbolicLink())
      throw new AppError("unauthorized", "不能把符号链接当作授权目录。");
    if (!stat.isDirectory())
      throw new AppError("invalid_input", "只能授权一个实际目录。");
    let real: string;
    try {
      real = realpathSync(root);
    } catch {
      throw new AppError("unavailable", "无法确认目录的实际位置。");
    }
    if (ctx.canonicalPath(real) !== ctx.canonicalPath(root))
      throw new AppError("unauthorized", "目录解析后指向了其他位置，未授权。");
    const existing = this.db
      .prepare(
        "SELECT id FROM directory_grants WHERE conversationId=? AND root=?",
      )
      .get(conversationId, real);
    if (existing) return { id: z.string().parse(existing.id) };
    const count = z
      .object({ n: z.number() })
      .parse(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM directory_grants WHERE conversationId=?",
          )
          .get(conversationId),
      ).n;
    if (count >= 8)
      throw new AppError("capacity", "每个会话最多授权 8 个目录。");
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO directory_grants(id,conversationId,root,createdAt) VALUES(?,?,?,?)",
      )
      .run(id, conversationId, real, Date.now());
    return { id };
  }
  create(
    command: Extract<Command, { type: "conversation.create" }>,
    ctx: ConversationCommandContext,
  ) {
    ctx.requireBot(command.botId);
    const id = ctx.createConversation(command.botId);
    return { id, conversationId: id };
  }
  update(
    command: Extract<Command, { type: "conversation.update" }>,
    ctx: ConversationCommandContext,
  ) {
    ctx.requireConversation(command.conversationId);
    this.db
      .prepare("UPDATE conversations SET hidden=?,pinned=? WHERE id=?")
      .run(
        Number(command.hidden),
        Number(command.pinned),
        command.conversationId,
      );
    return {};
  }
  markRead(
    command: Extract<Command, { type: "conversation.read" }>,
    ctx: ConversationCommandContext,
  ) {
    ctx.requireConversation(command.conversationId);
    if (
      command.through > 0 &&
      !this.db
        .prepare(
          "SELECT id FROM messages WHERE conversationId=? AND sequence=?",
        )
        .get(command.conversationId, command.through)
    )
      throw new AppError("invalid_input", "阅读位置不属于当前会话。");
    this.db
      .prepare(
        "UPDATE conversations SET lastReadSequence=max(lastReadSequence,?),markedUnread=0 WHERE id=? AND readVersion=?",
      )
      .run(command.through, command.conversationId, command.readVersion);
    return {};
  }
  markUnread(
    command: Extract<Command, { type: "conversation.unread" }>,
    ctx: ConversationCommandContext,
  ) {
    ctx.requireConversation(command.conversationId);
    this.db
      .prepare(
        "UPDATE conversations SET markedUnread=1,readVersion=readVersion+1 WHERE id=?",
      )
      .run(command.conversationId);
    return {};
  }
  saveDraft(
    command: Extract<Command, { type: "draft.save" }>,
    ctx: ConversationCommandContext,
  ) {
    ctx.requireConversation(command.conversationId);
    this.db
      .prepare("UPDATE conversations SET draft=? WHERE id=?")
      .run(command.text, command.conversationId);
    return {};
  }
  saveReply(
    command: Extract<Command, { type: "reply.save" }>,
    ctx: ConversationCommandContext,
  ) {
    ctx.requireConversation(command.conversationId);
    if (command.messageId) ctx.quote(command.conversationId, command.messageId);
    this.db
      .prepare("UPDATE conversations SET replyToId=? WHERE id=?")
      .run(command.messageId, command.conversationId);
    return {};
  }
  selectSkills(
    command: Extract<Command, { type: "skills.select" }>,
    ctx: ConversationCommandContext,
  ) {
    ctx.requireConversation(command.conversationId);
    const previous = skillReferencesSchema.parse(
      JSON.parse(
        z
          .string()
          .parse(
            this.db
              .prepare("SELECT draftSkillsJson FROM conversations WHERE id=?")
              .get(command.conversationId)?.draftSkillsJson,
          ),
      ),
    );
    if (
      new Set(command.references.map((reference) => reference.id)).size !==
      command.references.length
    )
      throw new AppError("invalid_input", "技能不能重复引用。");
    ctx.skills.freeze(
      command.references.filter(
        (ref) =>
          !previous.some(
            (item) =>
              item.id === ref.id &&
              item.botId === ref.botId &&
              item.revision === ref.revision,
          ),
      ),
      ctx.skillOwners(command.conversationId),
    );
    this.db
      .prepare("UPDATE conversations SET draftSkillsJson=?,draft=? WHERE id=?")
      .run(
        JSON.stringify(command.references),
        command.text,
        command.conversationId,
      );
    return {};
  }
  removeAttachment(
    command: Extract<Command, { type: "attachment.remove" }>,
    ctx: ConversationCommandContext,
  ) {
    ctx.requireConversation(command.conversationId);
    const old = this.db
      .prepare("SELECT conversationId,messageId FROM attachments WHERE id=?")
      .get(command.id);
    if (
      old &&
      (old.conversationId !== command.conversationId || old.messageId !== null)
    )
      throw new AppError("conflict", "只能移除当前会话尚未发送的附件。");
    this.db
      .prepare("INSERT OR IGNORE INTO attachment_cancellations VALUES(?,?)")
      .run(command.id, command.conversationId);
    this.db
      .prepare(
        "DELETE FROM attachments WHERE id=? AND conversationId=? AND messageId IS NULL",
      )
      .run(command.id, command.conversationId);
    return {};
  }
  grantDirectory(
    command: Extract<Command, { type: "directory.attach" }>,
    ctx: ConversationCommandContext,
  ) {
    return this.attachDirectory(ctx, command.conversationId, command.root);
  }
  revokeDirectory(
    command: Extract<Command, { type: "directory.revoke" }>,
    ctx: ConversationCommandContext,
  ) {
    ctx.requireConversation(command.conversationId);
    const grant = this.db
      .prepare("SELECT conversationId FROM directory_grants WHERE id=?")
      .get(command.id);
    if (grant && grant.conversationId !== command.conversationId)
      throw new AppError("unauthorized", "这个目录授权不属于当前会话。");
    this.db
      .prepare("DELETE FROM directory_grants WHERE id=? AND conversationId=?")
      .run(command.id, command.conversationId);
    return {};
  }
}
