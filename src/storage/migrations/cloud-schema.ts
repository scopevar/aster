import type { DatabaseSync } from "node:sqlite";

/** Local preparation is durable; only acknowledged jobs may enter execution. */
export function migrateCloudChats(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE cloud_chat_state(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,receiving INTEGER NOT NULL DEFAULT 0,cursor INTEGER NOT NULL DEFAULT 0,deviceId TEXT);
    INSERT INTO cloud_chat_state(id) VALUES(1);
    CREATE TABLE cloud_chat_entities(kind TEXT NOT NULL,entityId TEXT NOT NULL,version INTEGER NOT NULL,sourceDevice TEXT NOT NULL,sequence INTEGER,payload TEXT,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,entityId));
    CREATE TABLE cloud_chat_dirty(kind TEXT NOT NULL,entityId TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,entityId));
    CREATE TABLE cloud_chat_outbox(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,entityId TEXT NOT NULL,body TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE cloud_chat_files(id TEXT PRIMARY KEY,conversationId TEXT NOT NULL,name TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,data BLOB NOT NULL);
    CREATE TABLE cloud_chat_collaboration_outbox(id TEXT PRIMARY KEY,action TEXT NOT NULL,roomId TEXT,body TEXT NOT NULL);
    ALTER TABLE runs ADD COLUMN cloudRemote INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN cloudSequence INTEGER;
    DROP INDEX one_active_bot;
    CREATE UNIQUE INDEX one_active_bot ON runs(botId) WHERE status IN ('running','cancelling') AND cloudRemote=0;
    DROP TRIGGER message_conversation_insert;
    CREATE TRIGGER message_conversation_insert BEFORE INSERT ON messages
    WHEN NEW.conversationId IS NULL OR NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=NEW.runId AND r.conversationId=NEW.conversationId AND (r.botId=NEW.botId OR EXISTS(SELECT 1 FROM group_turns t WHERE t.runId=NEW.runId AND t.botId=NEW.botId AND (t.status='running' OR r.cloudRemote=1))))
    BEGIN SELECT RAISE(ABORT,'message conversation mismatch'); END;
  `);
  for (const [table, kind] of [
    ["bots", "bot"],
    ["conversations", "conversation"],
    ["runs", "run"],
    ["messages", "message"],
  ]) {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      db.exec(`CREATE TRIGGER cloud_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
        WHEN (SELECT enabled=1 AND receiving=0 FROM cloud_chat_state WHERE id=1)
        BEGIN INSERT INTO cloud_chat_dirty(kind,entityId,deleted) VALUES('${kind}',${row}.id,${Number(event === "DELETE")})
        ON CONFLICT(kind,entityId) DO UPDATE SET deleted=excluded.deleted; END;`);
    }
  }
  for (const [table, column, kind] of [
    ["groups", "conversationId", "conversation"],
    ["group_members", "conversationId", "conversation"],
    ["group_turns", "runId", "run"],
    ["reactions", "messageId", "message"],
    ["attachments", "messageId", "message"],
  ]) {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      db.exec(`CREATE TRIGGER cloud_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
        WHEN ${row}.${column} IS NOT NULL AND (SELECT enabled=1 AND receiving=0 FROM cloud_chat_state WHERE id=1)
        BEGIN INSERT OR IGNORE INTO cloud_chat_dirty(kind,entityId) VALUES('${kind}',${row}.${column}); END;`);
    }
  }
  for (const table of ["sidebar_state", "sidebar_sections", "sidebar_members"])
    for (const event of ["INSERT", "UPDATE", "DELETE"])
      db.exec(`CREATE TRIGGER cloud_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
    WHEN (SELECT enabled=1 AND receiving=0 FROM cloud_chat_state WHERE id=1)
    BEGIN INSERT OR IGNORE INTO cloud_chat_dirty(kind,entityId) VALUES('sidebar','00000000-0000-4000-8000-000000000001'); END;`);
}
