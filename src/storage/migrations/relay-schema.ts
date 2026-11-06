import type { DatabaseSync } from "node:sqlite";

export function createRelayTables(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE relay_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE relay_peers(id TEXT PRIMARY KEY,device TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,authorized INTEGER NOT NULL DEFAULT 0,live INTEGER NOT NULL DEFAULT 0,sendSequence INTEGER NOT NULL DEFAULT 0,receiveSequence INTEGER NOT NULL DEFAULT 0,journalCursor INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE relay_outbox(id TEXT PRIMARY KEY,recipient TEXT NOT NULL,envelope TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE relay_inbox(cursor INTEGER PRIMARY KEY,envelope TEXT NOT NULL);
    CREATE TABLE relay_packets(sender TEXT NOT NULL,transferId TEXT NOT NULL,part INTEGER NOT NULL,total INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(sender,transferId,part));
    CREATE TABLE relay_requests(id TEXT PRIMARY KEY,workspaceId TEXT NOT NULL,sender TEXT NOT NULL,operationType TEXT NOT NULL,body TEXT NOT NULL,fingerprint TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'received',result TEXT,error TEXT);
    CREATE INDEX relay_request_status ON relay_requests(workspaceId,phase);
    CREATE TABLE relay_cancellations(requestId TEXT PRIMARY KEY);
    CREATE TABLE relay_dirty(kind TEXT NOT NULL,entityId TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,entityId));
    CREATE TABLE relay_journal(sequence INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);
    CREATE TABLE relay_cache(workspaceId TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT,revision INTEGER NOT NULL,PRIMARY KEY(workspaceId,kind,id));
  `);
}

export function migrateRelay(db: DatabaseSync) {
  createRelayTables(db);
  db.exec(`
    UPDATE cloud_chat_state SET enabled=0;
    UPDATE runs SET status='unknown',error='旧版本任务未自动重放，请核实后发送新请求。' WHERE status='queued';
    UPDATE group_turns SET status='unknown',error='旧版本成员任务未自动重放。' WHERE status='queued';
    UPDATE template_jobs SET status='unknown',error='旧版本发布队列未自动重放，请核实原提交。' WHERE status='queued';
    UPDATE memory_jobs SET status='cancelled',error='旧版本记忆任务未自动重放。' WHERE status='queued';
    UPDATE routines SET state='paused',nextAt=NULL,revision=revision+1,error='旧版本计划已保留，请确认后手动启用，不自动补跑。' WHERE state<>'deleted';
  `);
  const mark = (
    table: string,
    column: string,
    kind: string,
    entity: boolean,
  ) => {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      db.exec(`CREATE TRIGGER relay_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
        WHEN ${row}.${column} IS NOT NULL AND EXISTS(SELECT 1 FROM relay_settings WHERE key='mode' AND value='"host"')
        BEGIN INSERT INTO relay_dirty(kind,entityId,deleted) VALUES('${kind}',${row}.${column},${Number(entity && event === "DELETE")})
        ON CONFLICT(kind,entityId) DO UPDATE SET deleted=excluded.deleted; END;`);
    }
  };
  for (const [table, kind] of [
    ["bots", "bot"],
    ["conversations", "conversation"],
    ["runs", "run"],
    ["messages", "message"],
  ])
    mark(table!, "id", kind!, true);
  for (const [table, column, kind] of [
    ["groups", "conversationId", "conversation"],
    ["group_members", "conversationId", "conversation"],
    ["group_turns", "runId", "run"],
    ["reactions", "messageId", "message"],
    ["attachments", "messageId", "message"],
    ["computer_calls", "messageId", "message"],
    ["plugin_calls", "messageId", "message"],
    ["questions", "messageId", "message"],
    ["document_calls", "messageId", "message"],
    ["routine_tool_calls", "messageId", "message"],
    ["template_tool_calls", "messageId", "message"],
  ])
    mark(table!, column!, kind!, false);
}
