import type { DatabaseSync } from "node:sqlite";

export function migrateIm(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE im_state(id INTEGER PRIMARY KEY CHECK(id=1),cursor INTEGER NOT NULL DEFAULT 0,notificationCursor INTEGER NOT NULL DEFAULT 0);
    INSERT INTO im_state(id) VALUES(1);
    CREATE TABLE im_rooms(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE im_messages(id TEXT PRIMARY KEY,roomId TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,receivedCursor INTEGER,UNIQUE(roomId,sequence));
    CREATE INDEX im_history ON im_messages(roomId,sequence);
    CREATE INDEX im_received_cursor ON im_messages(receivedCursor) WHERE receivedCursor IS NOT NULL;
    CREATE TABLE im_members(roomId TEXT NOT NULL,accountId TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(roomId,accountId));
    CREATE TABLE im_receipts(roomId TEXT NOT NULL,accountId TEXT NOT NULL,kind TEXT NOT NULL,through INTEGER NOT NULL,PRIMARY KEY(roomId,accountId,kind));
    CREATE TABLE im_files(id TEXT PRIMARY KEY,roomId TEXT NOT NULL,name TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,complete INTEGER NOT NULL DEFAULT 0,cloudUploaded INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL);
    CREATE TABLE im_file_chunks(id TEXT NOT NULL REFERENCES im_files(id) ON DELETE CASCADE,chunk INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(id,chunk));
    ALTER TABLE cloud_chat_collaboration_outbox ADD COLUMN error TEXT;
  `);
}
