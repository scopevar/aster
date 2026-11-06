import type { DatabaseSync } from "node:sqlite";
/** Runs inside the caller's deletion transaction; preserves cyclic-reference cleanup order. */
export function purgeConversation(db: DatabaseSync, id: string) {
  db.prepare(
    "INSERT OR IGNORE INTO deleted_client_keys SELECT 'skill-editor:'||botId||':'||id FROM conversations WHERE id=?",
  ).run(id);
  db.prepare(
    "INSERT OR IGNORE INTO deleted_client_keys SELECT 'memory-editor:'||botId||':'||conversationId FROM group_members WHERE conversationId=?",
  ).run(id);
  db.prepare(
    "INSERT OR IGNORE INTO deleted_client_keys SELECT 'question-draft:'||id FROM questions WHERE conversationId=?",
  ).run(id);
  db.prepare(
    "INSERT OR IGNORE INTO deleted_client_keys SELECT 'question-answer:'||id FROM questions WHERE conversationId=?",
  ).run(id);
  db.prepare(
    "INSERT OR IGNORE INTO deleted_client_keys SELECT 'tool-approval:'||id FROM computer_calls WHERE conversationId=?",
  ).run(id);
  db.prepare(
    "INSERT OR IGNORE INTO deleted_client_keys SELECT 'memory-editor:'||botId||':'||scopeId FROM memory_scopes WHERE conversationId=?",
  ).run(id);
  // Clear cyclic input/reply references before removing their payloads.
  db.prepare("UPDATE conversations SET replyToId=NULL WHERE id=?").run(id);
  db.prepare("UPDATE runs SET inputMessageId=NULL WHERE conversationId=?").run(
    id,
  );
  db.prepare("DELETE FROM questions WHERE conversationId=?").run(id);
  db.prepare("DELETE FROM computer_calls WHERE conversationId=?").run(id);
  db.prepare(
    "DELETE FROM skill_tool_calls WHERE runId IN(SELECT id FROM runs WHERE conversationId=?)",
  ).run(id);
  db.prepare(
    "DELETE FROM memory_jobs WHERE sourceMessageId IN(SELECT id FROM messages WHERE conversationId=?)",
  ).run(id);
  db.prepare("DELETE FROM memories WHERE scopeId=?").run(id);
  db.prepare("DELETE FROM memory_scopes WHERE conversationId=?").run(id);
  db.prepare(
    "DELETE FROM group_turn_context WHERE runId IN(SELECT id FROM runs WHERE conversationId=?)",
  ).run(id);
  db.prepare("DELETE FROM group_context WHERE conversationId=?").run(id);
  db.prepare(
    "DELETE FROM group_turns WHERE runId IN(SELECT id FROM runs WHERE conversationId=?)",
  ).run(id);
  db.prepare("DELETE FROM group_members WHERE conversationId=?").run(id);
  db.prepare("DELETE FROM groups WHERE conversationId=?").run(id);
  db.prepare(
    "DELETE FROM group_discussions WHERE runId IN(SELECT id FROM runs WHERE conversationId=?)",
  ).run(id);
  db.prepare("DELETE FROM thread_owners WHERE conversationId=?").run(id);
  db.prepare(
    "DELETE FROM reactions WHERE messageId IN(SELECT id FROM messages WHERE conversationId=?)",
  ).run(id);
  db.prepare("DELETE FROM attachments WHERE conversationId=?").run(id);
  db.prepare("DELETE FROM directory_grants WHERE conversationId=?").run(id);
  db.prepare("DELETE FROM attachment_cancellations WHERE conversationId=?").run(
    id,
  );
  // Bot-private memories can reference a private conversation being deleted.
  db.prepare(
    "DELETE FROM memories WHERE sourceMessageId IN(SELECT id FROM messages WHERE conversationId=?)",
  ).run(id);
  db.prepare("DELETE FROM messages WHERE conversationId=?").run(id);
  db.prepare("DELETE FROM runs WHERE conversationId=?").run(id);
  db.prepare("DELETE FROM deletion_conversations WHERE conversationId=?").run(
    id,
  );
  db.prepare("DELETE FROM conversations WHERE id=?").run(id);
}
