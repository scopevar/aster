import type { PluginCallStorage } from "./tools/plugin-calls.js";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Attachment } from "../shared/files/attachments.js";
import { AppError } from "../shared/core.js";
import { botSchema } from "../shared/chat/bots.js";
import {
  conversationSchema,
  type Quote,
} from "../shared/chat/conversations.js";
import { messageSchema, type Message } from "../shared/chat/messages.js";
import { runSchema } from "../shared/chat/runs.js";
import { type Query } from "../shared/snapshot.js";
import {
  messageHistoryQuerySchema,
  messageHistoryResultSchema,
  messageSearchQuerySchema,
  messageSearchResultSchema,
  type MessageHistoryQuery,
  type MessageSearchQuery,
} from "../shared/chat/message-search.js";
import {
  skillReferencesSchema,
  summarizeSkill,
  type Skill,
} from "../shared/tools/skills.js";
import type { StoreCursor } from "../shared/worker-events.js";
import { avatarSchema } from "../shared/avatar.js";
import { conversationRelations } from "./chat/conversation-relations.js";
import { messagePreview, plainTextPreview } from "./chat/message-preview.js";
import { cloudPayloadSchema } from "../shared/chat/cloud-chats.js";
import type { DeletionStorage } from "./deletions/deletions.js";
import type { DocumentStorage } from "./documents/documents.js";
import type { GroupStorage } from "./chat/groups.js";
import type { QuestionStorage } from "./tools/questions.js";
import type { RoutineService } from "../routines/service.js";
import type { SidebarSectionStorage } from "./chat/sidebar-sections.js";
import type { SkillStorage } from "./tools/skills.js";
import type { TemplateToolStorage } from "./templates/template-tools.js";
import type { ToolCallStorage } from "./tools/tool-calls.js";
type ViewContext = {
  pluginCalls: Pick<PluginCallStorage, "forMessage">;
  skills: Pick<SkillStorage, "list" | "content">;
  groups: Pick<GroupStorage, "read" | "turns">;
  deletions: Pick<DeletionStorage, "list" | "clientKeys">;
  sidebar: Pick<SidebarSectionStorage, "read">;
  routines: Pick<RoutineService, "calls">;
  templateTools: Pick<TemplateToolStorage, "receipt">;
  toolCalls: Pick<ToolCallStorage, "forMessage">;
  questions: Pick<QuestionStorage, "forMessage">;
  documents: Pick<DocumentStorage, "forMessage">;
  cursor(): StoreCursor;
  listAttachments(
    conversationId: string,
    messageId: string | null,
  ): Attachment[];
  quote(conversationId: string, messageId: string): Quote;
  skillOwners(conversationId: string): string[];
  messageSkills(messageId: string): Skill[];
};
export class SnapshotReader {
  private readonly previews = new Map<
    string,
    { source: string; text: string }
  >();

  private preview(id: string, source: string): string {
    const cached = this.previews.get(id);
    if (cached?.source === source) return cached.text;
    const text = messagePreview(source);
    this.previews.delete(id);
    this.previews.set(id, { source, text });
    if (this.previews.size > 100) {
      const oldest = this.previews.keys().next();
      if (!oldest.done) this.previews.delete(oldest.value);
    }
    return text;
  }

  constructor(
    private readonly db: DatabaseSync,
    private readonly context: ViewContext,
  ) {}
  snapshot(query: Query) {
    if (
      query.conversationId &&
      (!this.db
        .prepare("SELECT 1 FROM conversations WHERE id=?")
        .get(query.conversationId) ||
        this.db
          .prepare(
            "SELECT 1 FROM deletion_conversations WHERE conversationId=?",
          )
          .get(query.conversationId))
    )
      query = {};
    const bots = this.db
      .prepare("SELECT * FROM bots ORDER BY createdAt,id")
      .all()
      .map((row) =>
        botSchema.parse({
          ...row,
          avatar: avatarSchema.parse(
            JSON.parse(z.string().parse(row.avatarJson)),
          ),
        }),
      );
    const relations = conversationRelations(this.db);
    const conversations = this.db
      .prepare(
        `SELECT c.*,COALESCE((SELECT COALESCE(NULLIF(m.text,''),(SELECT '附件：'||group_concat(name,'、') FROM attachments WHERE messageId=m.id)) FROM messages m WHERE conversationId=c.id ORDER BY sequence DESC LIMIT 1),'') AS preview,
        COALESCE((SELECT text='' FROM messages WHERE conversationId=c.id ORDER BY sequence DESC LIMIT 1),0) AS previewIsAttachment,
        COALESCE((SELECT createdAt FROM messages WHERE conversationId=c.id ORDER BY sequence DESC LIMIT 1),c.createdAt) AS activityAt,
        (SELECT count(*) FROM messages m WHERE conversationId=c.id AND role='assistant' AND toolJson IS NULL AND NOT EXISTS(SELECT 1 FROM computer_calls t WHERE t.messageId=m.id) AND sequence>c.lastReadSequence) AS unreadCount,
        (SELECT status FROM runs WHERE conversationId=c.id AND status IN ('queued','running','cancelling') ORDER BY CASE status WHEN 'cancelling' THEN 0 WHEN 'running' THEN 1 ELSE 2 END LIMIT 1) AS activityStatus
        FROM conversations c ORDER BY pinned DESC,activityAt DESC,c.rowid DESC`,
      )
      .all()
      .map((row) =>
        conversationSchema.parse({
          ...row,
          preview:
            row.previewIsAttachment === 1
              ? plainTextPreview(z.string().parse(row.preview))
              : this.preview(
                  z.string().parse(row.id),
                  z.string().parse(row.preview),
                ),
          deletionPending: relations.deleting.has(z.string().parse(row.id)),
          hidden: row.hidden === 1,
          pinned: row.pinned === 1,
          markedUnread: row.markedUnread === 1,
          draftAttachments:
            relations.attachments.get(z.string().parse(row.id)) ?? [],
          directoryGrants: relations.grants.get(z.string().parse(row.id)) ?? [],
          draftSkills: skillReferencesSchema
            .parse(JSON.parse(z.string().parse(row.draftSkillsJson)))
            .map((ref) => summarizeSkill(this.context.skills.content(ref))),
          group: relations.groups.get(z.string().parse(row.id)) ?? null,
          replyTo: row.replyToId
            ? this.context.quote(
                z.string().parse(row.id),
                z.string().parse(row.replyToId),
              )
            : null,
        }),
      );
    const conversationId = query.conversationId ?? "";
    const rows = this.db
      .prepare(
        "SELECT m.*,r.status AS runStatus,r.error AS runError FROM messages m JOIN runs r ON r.id=m.runId WHERE m.conversationId=? AND m.sequence<? ORDER BY m.sequence DESC LIMIT 101",
      )
      .all(conversationId, query.before ?? Number.MAX_SAFE_INTEGER);
    const messages = rows
      .slice(0, 100)
      .reverse()
      .map((row) => this.materializeMessage(row, conversationId));
    const runs = this.db
      .prepare(
        "SELECT * FROM runs WHERE conversationId=? ORDER BY createdAt DESC,rowid DESC LIMIT 100",
      )
      .all(conversationId)
      .map((row) =>
        runSchema.parse({
          ...row,
          groupTurns: this.context.groups.turns(z.string().parse(row.id)),
        }),
      );
    return {
      ...this.context.cursor(),
      deletions: this.context.deletions.list(),
      sidebar: this.context.sidebar.read(),
      deletedClientKeys: this.context.deletions.clientKeys(),
      bots,
      skills: query.conversationId
        ? this.context.skills.list(
            this.context.skillOwners(query.conversationId),
          )
        : [],
      conversations,
      recentEmojis: this.db
        .prepare(
          "SELECT emoji FROM recent_emojis WHERE userId='local' ORDER BY usedOrder DESC,rowid DESC LIMIT 24",
        )
        .all()
        .map((row) => z.string().parse(row.emoji)),
      messages,
      runs,
      hasOlder: rows.length > 100,
    };
  }
  materializeMessage(
    row: Record<string, unknown>,
    conversationId: string,
  ): Message {
    const id = z.string().parse(row.id);
    const remote = this.db
      .prepare("SELECT 1 FROM runs WHERE id=? AND cloudRemote=1")
      .get(z.string().parse(row.runId));
    const projection = remote
      ? this.db
          .prepare(
            "SELECT payload FROM cloud_chat_entities WHERE kind='message' AND entityId=? AND deleted=0",
          )
          .get(id)
      : undefined;
    if (projection?.payload) {
      const payload = cloudPayloadSchema.parse(
        JSON.parse(z.string().parse(projection.payload)),
      );
      if (payload.kind === "message") {
        const reactions = this.db
          .prepare(
            "SELECT emoji,count(*) AS count,max(userId='local') AS mine FROM reactions WHERE messageId=? GROUP BY emoji",
          )
          .all(id)
          .map((r) => ({ ...r, mine: r.mine === 1 }));
        return messageSchema.parse({
          ...payload.value,
          sendStatus: "sent",
          reactions,
          syncStatus: "synced",
          sequence: row.sequence,
          runStatus: row.runStatus,
          runError: row.runError,
        });
      }
    }
    const reactions = this.db
      .prepare(
        "SELECT emoji,count(*) AS count,max(userId='local') AS mine FROM reactions WHERE messageId=? GROUP BY emoji",
      )
      .all(id)
      .map((r) => ({ ...r, mine: r.mine === 1 }));
    const ordinal =
      row.role === "assistant" && this.context.groups.read(conversationId)
        ? /^(\d+):/.exec(z.string().nullable().parse(row.itemId) ?? "")?.[1]
        : undefined;
    return messageSchema.parse({
      sendStatus: "sent",
      syncStatus: "local",
      groupOrdinal: ordinal === undefined ? null : Number(ordinal),
      routine: this.context.routines.calls.receipt(z.string().parse(row.id)),
      template: this.context.templateTools.receipt(z.string().parse(row.id)),
      ...row,
      reactions,
      attachments: this.context.listAttachments(conversationId, id),
      skills: this.context.messageSkills(id).map((s) => summarizeSkill(s)),
      replyTo: row.replyJson
        ? JSON.parse(z.string().parse(row.replyJson))
        : null,
      tool: row.toolJson ? JSON.parse(z.string().parse(row.toolJson)) : null,
      computerTool: this.context.toolCalls.forMessage(id),
      pluginCall: this.context.pluginCalls.forMessage(id),
      question: this.context.questions.forMessage(id),
      document: this.context.documents.forMessage(id),
    });
  }
  searchMessages(input: MessageSearchQuery) {
    const query = messageSearchQuerySchema.parse(input);
    const rows = this.db
      .prepare(
        `SELECT m.id,m.conversationId,m.sequence,m.role,m.text,m.createdAt
       FROM messages m JOIN conversations c ON c.id=m.conversationId
       WHERE m.sequence<? AND c.hidden=0 AND m.toolJson IS NULL
       AND NOT EXISTS(SELECT 1 FROM computer_calls t WHERE t.messageId=m.id)
       AND NOT EXISTS(SELECT 1 FROM deletion_conversations d WHERE d.conversationId=c.id)
       ORDER BY m.sequence DESC LIMIT 501`,
      )
      .all(query.before ?? Number.MAX_SAFE_INTEGER);
    const needle = query.text.toLocaleLowerCase();
    const hits: unknown[] = [];
    let scanned = 0;
    let lastSequence: number | null = null;
    for (const row of rows) {
      if (scanned === 500 || hits.length === 50) break;
      scanned++;
      const sequence = z.number().parse(row.sequence);
      lastSequence = sequence;
      const body = z.string().parse(row.text);
      const index = body.toLocaleLowerCase().indexOf(needle);
      if (index < 0) continue;
      const start = Math.max(0, index - Math.min(70, 180 - needle.length));
      const excerpt = `${start ? "…" : ""}${body.slice(start, start + 180)}${body.length > start + 180 ? "…" : ""}`;
      hits.push({
        messageId: row.id,
        conversationId: row.conversationId,
        sequence,
        role: row.role,
        createdAt: row.createdAt,
        excerpt,
      });
    }
    return messageSearchResultSchema.parse({
      version: 1,
      hits,
      scanned,
      nextBefore: rows.length > scanned ? lastSequence : null,
    });
  }
  messageHistory(input: MessageHistoryQuery) {
    const query = messageHistoryQuerySchema.parse(input);
    const allowed = this.db
      .prepare(
        `SELECT 1 FROM conversations c
       WHERE c.id=? AND c.hidden=0
       AND NOT EXISTS(SELECT 1 FROM deletion_conversations d WHERE d.conversationId=c.id)`,
      )
      .get(query.conversationId);
    if (!allowed) throw new AppError("not_found", "会话不存在或不可查看。");
    const anchor = this.db
      .prepare(
        query.direction === "around"
          ? "SELECT sequence FROM messages WHERE id=? AND conversationId=?"
          : "SELECT sequence FROM messages WHERE sequence=? AND conversationId=?",
      )
      .get(
        query.direction === "around" ? query.messageId : query.sequence,
        query.conversationId,
      );
    if (!anchor) throw new AppError("not_found", "定位消息不存在于该会话。");
    const sequence = z.number().parse(anchor.sequence);
    const select = (comparison: string, order: string, limit: number) =>
      this.db
        .prepare(
          `SELECT m.*,r.status AS runStatus,r.error AS runError FROM messages m JOIN runs r ON r.id=m.runId WHERE m.conversationId=? AND m.sequence${comparison}? ORDER BY m.sequence ${order} LIMIT ${limit}`,
        )
        .all(query.conversationId, sequence);
    const rows =
      query.direction === "around"
        ? [...select("<=", "DESC", 50).reverse(), ...select(">", "ASC", 50)]
        : query.direction === "before"
          ? select("<", "DESC", 100).reverse()
          : select(">", "ASC", 100);
    const first = rows.length ? z.number().parse(rows[0]?.sequence) : sequence;
    const last = rows.length
      ? z.number().parse(rows.at(-1)?.sequence)
      : sequence;
    const exists = (comparison: string, value: number) =>
      !!this.db
        .prepare(
          `SELECT 1 FROM messages WHERE conversationId=? AND sequence${comparison}? LIMIT 1`,
        )
        .get(query.conversationId, value);
    return messageHistoryResultSchema.parse({
      version: 1,
      conversationId: query.conversationId,
      messages: rows.map((row) =>
        this.materializeMessage(row, query.conversationId),
      ),
      hasOlder: exists("<", first),
      hasNewer: exists(">", last),
    });
  }
}
