import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  attachmentSchema,
  type Attachment,
} from "../../shared/files/attachments.js";
import { groupSchema, type Group } from "../../shared/chat/conversations.js";

/** Loads sidebar relations in bounded query count, never reading attachment blobs. */
export function conversationRelations(db: DatabaseSync) {
  const attachments = new Map<string, Attachment[]>();
  for (const row of db
    .prepare(
      "SELECT id,conversationId,name,kind,mime,size,hash,createdAt,messageId FROM attachments WHERE messageId IS NULL ORDER BY createdAt,rowid",
    )
    .all()) {
    const attachment = attachmentSchema.parse(row);
    const list = attachments.get(attachment.conversationId) ?? [];
    list.push(attachment);
    attachments.set(attachment.conversationId, list);
  }
  const grants = new Map<string, { id: string; root: string }[]>();
  const grantSchema = z.object({
    conversationId: z.string(),
    id: z.string(),
    root: z.string(),
  });
  for (const value of db
    .prepare(
      "SELECT conversationId,id,root FROM directory_grants ORDER BY createdAt,rowid",
    )
    .all()) {
    const row = grantSchema.parse(value);
    const list = grants.get(row.conversationId) ?? [];
    list.push({ id: row.id, root: row.root });
    grants.set(row.conversationId, list);
  }
  const members = new Map<string, string[]>();
  for (const value of db
    .prepare(
      "SELECT conversationId,botId FROM group_members WHERE active=1 ORDER BY position",
    )
    .all()) {
    const row = z
      .object({ conversationId: z.string(), botId: z.string() })
      .parse(value);
    const list = members.get(row.conversationId) ?? [];
    list.push(row.botId);
    members.set(row.conversationId, list);
  }
  const groups = new Map<string, Group>();
  for (const row of db
    .prepare("SELECT * FROM groups WHERE ownerId='local'")
    .all()) {
    const id = z.string().parse(row.conversationId);
    groups.set(
      id,
      groupSchema.parse({
        ...row,
        draft: row.draft === 1,
        memberIds: members.get(id) ?? [],
        draftRecipientIds: JSON.parse(z.string().parse(row.draftRecipientJson)),
      }),
    );
  }
  const deleting = new Set(
    db
      .prepare("SELECT conversationId FROM deletion_conversations")
      .all()
      .map((row) => z.string().parse(row.conversationId)),
  );
  return { attachments, grants, groups, deleting };
}
