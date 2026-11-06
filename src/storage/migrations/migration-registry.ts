import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { maxDatabaseVersion, minDatabaseVersion } from "../../shared/backup.js";
import { AppError } from "../../shared/core.js";
import { migrateConversationContext } from "../chat/conversation-context.js";
import { migrateCloudChats } from "./cloud-schema.js";
import { migrateIm } from "./im-schema.js";
import { retiredComputerSchema } from "./retired-computer-schema.js";
import { migrateRelay } from "./relay-schema.js";
import { saveMigrationBackup } from "./migration-backup.js";
import { migrateGroupHost } from "../chat/group-host.js";
import { migrateLocalWorkspace } from "./local-workspace-migration.js";

/** One schema step. `version` is the user_version written after `migrate` succeeds. */
export type Migration = {
  version: number;
  module: string;
  migrate: (db: DatabaseSync, fromVersion: number) => void;
};

export type MigrationModules = {
  plugins: { migrate(): void };
  pluginCalls: { migrate(): void };
  groups: { migrate: () => void };
  avatars: { migrate: () => void };
  skills: { migrate: () => void };
  memory: { migrate: () => void };
  sharedMemory: { migrate: () => void };
  toolCalls: { migrate: () => void };
  questions: { migrate: () => void };
  skillTools: { migrate: () => void };
  deletions: { migrate: () => void };
  sidebar: { migrate: () => void };
  documents: { migrate: () => void; migrateOffice: () => void };
  routines: { repository: { migrate: () => void } };
  templates: { migrate: () => void };
  templateTools: { migrate: () => void };
};

/**
 * Install steps start at 2. An empty database has user_version 0 and receives
 * every step. Existing supported schemas receive the remaining steps atomically.
 */
export function assertMigrationRegistry(migrations: readonly Migration[]) {
  if (migrations.length === 0) throw new Error("迁移注册表为空。");
  const seen = new Set<number>();
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (!migration || migration.module.trim() === "")
      throw new Error("迁移缺少所属模块。");
    if (!Number.isInteger(migration.version))
      throw new Error(`迁移版本无效：${migration?.version}`);
    if (seen.has(migration.version))
      throw new Error(`迁移版本重复：${migration.version}`);
    seen.add(migration.version);
    const previous = migrations[index - 1];
    if (previous && migration.version !== previous.version + 1)
      throw new Error(
        `迁移版本不连续：${previous.version} → ${migration.version}`,
      );
  }
  if (migrations[0]?.version !== 2) throw new Error("首个迁移必须到达版本 2。");
  if (migrations[migrations.length - 1]?.version !== maxDatabaseVersion)
    throw new Error(
      `迁移最大版本与 maxDatabaseVersion 不一致：${migrations[migrations.length - 1]?.version}，${maxDatabaseVersion}。`,
    );
}

function migrateTo2(db: DatabaseSync, fromVersion: number) {
  if (fromVersion !== 0)
    throw new Error(`无法从版本 ${fromVersion} 建立当前结构。`);
  db.exec(`
      CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT INTO meta VALUES(1,0);
      CREATE TABLE bots(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,hidden INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL,threadId TEXT,draft TEXT NOT NULL DEFAULT '');
      CREATE TABLE runs(id TEXT PRIMARY KEY,botId TEXT NOT NULL REFERENCES bots(id),status TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','completed','failed','cancelled','unknown')),error TEXT,createdAt INTEGER NOT NULL,turnId TEXT);
      CREATE UNIQUE INDEX one_active_bot ON runs(botId) WHERE status IN ('running','cancelling');
      CREATE TABLE messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,botId TEXT NOT NULL REFERENCES bots(id),role TEXT NOT NULL CHECK(role IN ('user','assistant')),text TEXT NOT NULL,createdAt INTEGER NOT NULL,runId TEXT NOT NULL REFERENCES runs(id),itemId TEXT,UNIQUE(runId,itemId));
      CREATE INDEX message_history ON messages(botId,sequence);
      CREATE TABLE reactions(messageId TEXT NOT NULL REFERENCES messages(id),userId TEXT NOT NULL,emoji TEXT NOT NULL,PRIMARY KEY(messageId,userId,emoji));
      CREATE TABLE commands(id TEXT PRIMARY KEY,body TEXT NOT NULL,result TEXT NOT NULL);
    `);
}

function migrateTo3(db: DatabaseSync) {
  db.exec(`
          CREATE TABLE conversations(id TEXT PRIMARY KEY,botId TEXT NOT NULL REFERENCES bots(id),hidden INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL,threadId TEXT,draft TEXT NOT NULL DEFAULT '');
          INSERT INTO conversations SELECT id,id,hidden,pinned,createdAt,threadId,draft FROM bots;
          ALTER TABLE runs ADD COLUMN conversationId TEXT REFERENCES conversations(id);
          ALTER TABLE messages ADD COLUMN conversationId TEXT REFERENCES conversations(id);
          UPDATE runs SET conversationId=botId;
          UPDATE messages SET conversationId=botId;
          DROP INDEX message_history;
          CREATE INDEX message_history ON messages(conversationId,sequence);
          CREATE INDEX run_history ON runs(conversationId,createdAt);
          ALTER TABLE bots DROP COLUMN hidden;
          ALTER TABLE bots DROP COLUMN pinned;
          ALTER TABLE bots DROP COLUMN threadId;
          ALTER TABLE bots DROP COLUMN draft;
          CREATE TRIGGER run_conversation_insert BEFORE INSERT ON runs
          WHEN NEW.conversationId IS NULL OR NOT EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversationId AND botId=NEW.botId)
          BEGIN SELECT RAISE(ABORT,'run conversation mismatch'); END;
          CREATE TRIGGER run_conversation_update BEFORE UPDATE OF conversationId,botId ON runs
          WHEN NEW.conversationId IS NULL OR NOT EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversationId AND botId=NEW.botId)
          BEGIN SELECT RAISE(ABORT,'run conversation mismatch'); END;
          CREATE TRIGGER message_conversation_insert BEFORE INSERT ON messages
          WHEN NEW.conversationId IS NULL OR NOT EXISTS(SELECT 1 FROM runs WHERE id=NEW.runId AND botId=NEW.botId AND conversationId=NEW.conversationId)
          BEGIN SELECT RAISE(ABORT,'message conversation mismatch'); END;
          CREATE TRIGGER message_conversation_update BEFORE UPDATE OF conversationId,botId,runId ON messages
          WHEN NEW.conversationId IS NULL OR NOT EXISTS(SELECT 1 FROM runs WHERE id=NEW.runId AND botId=NEW.botId AND conversationId=NEW.conversationId)
          BEGIN SELECT RAISE(ABORT,'message conversation mismatch'); END;
        `);
}

function migrateTo4(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE recent_emojis(userId TEXT NOT NULL,emoji TEXT NOT NULL,usedOrder INTEGER NOT NULL,PRIMARY KEY(userId,emoji));",
  );
}

function migrateTo5(db: DatabaseSync) {
  db.exec(`
            ALTER TABLE conversations ADD COLUMN replyToId TEXT REFERENCES messages(id);
            ALTER TABLE messages ADD COLUMN replyJson TEXT;
            CREATE TRIGGER reply_scope_insert BEFORE INSERT ON conversations
            WHEN NEW.replyToId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM messages WHERE id=NEW.replyToId AND conversationId=NEW.id)
            BEGIN SELECT RAISE(ABORT,'reply conversation mismatch'); END;
            CREATE TRIGGER reply_scope_update BEFORE UPDATE OF replyToId ON conversations
            WHEN NEW.replyToId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM messages WHERE id=NEW.replyToId AND conversationId=NEW.id)
            BEGIN SELECT RAISE(ABORT,'reply conversation mismatch'); END;
          `);
}

function migrateTo6(db: DatabaseSync) {
  db.exec(
    "ALTER TABLE bots ADD COLUMN tags TEXT NOT NULL DEFAULT ''; ALTER TABLE bots ADD COLUMN language TEXT NOT NULL DEFAULT 'auto' CHECK(language IN ('auto','zh-CN','en','ja'));",
  );
}

function migrateTo7(db: DatabaseSync) {
  db.exec("ALTER TABLE messages ADD COLUMN toolJson TEXT;");
}

function migrateTo8(db: DatabaseSync) {
  db.exec(`
          ALTER TABLE conversations ADD COLUMN lastReadSequence INTEGER NOT NULL DEFAULT 0 CHECK(lastReadSequence >= 0);
          ALTER TABLE conversations ADD COLUMN markedUnread INTEGER NOT NULL DEFAULT 0 CHECK(markedUnread IN (0,1));
          ALTER TABLE conversations ADD COLUMN readVersion INTEGER NOT NULL DEFAULT 0 CHECK(readVersion >= 0);
          UPDATE conversations SET lastReadSequence=COALESCE((SELECT max(sequence) FROM messages WHERE conversationId=conversations.id),0);
        `);
}

function migrateTo9(db: DatabaseSync) {
  db.exec(`
          CREATE TABLE attachments(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','image')), mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0 AND size<=26214400), hash TEXT NOT NULL, createdAt INTEGER NOT NULL, messageId TEXT REFERENCES messages(id), data BLOB NOT NULL);
          CREATE INDEX attachment_draft ON attachments(conversationId,messageId);
          CREATE TABLE attachment_cancellations(id TEXT PRIMARY KEY,conversationId TEXT NOT NULL REFERENCES conversations(id));
          CREATE TRIGGER attachment_message_scope BEFORE UPDATE OF messageId ON attachments WHEN NEW.messageId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM messages WHERE id=NEW.messageId AND conversationId=NEW.conversationId) BEGIN SELECT RAISE(ABORT,'attachment scope mismatch'); END;
        `);
}

function migrateTo25(db: DatabaseSync) {
  const columns = db.prepare("PRAGMA table_info(messages)").all();
  if (!columns.some((column) => column.name === "consumed"))
    db.exec(
      "ALTER TABLE messages ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0;",
    );
}

function migrateTo26(db: DatabaseSync) {
  db.exec(`
          CREATE TEMP TABLE document_calls_media AS SELECT * FROM document_calls;
          DROP TABLE document_calls;
          CREATE TABLE attachments_media(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','image','pdf','docx','table','audio','video','file')), mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0 AND size<=26214400), hash TEXT NOT NULL, createdAt INTEGER NOT NULL, messageId TEXT REFERENCES messages(id), data BLOB NOT NULL);
          INSERT INTO attachments_media SELECT * FROM attachments;
          DROP TABLE attachments;
          ALTER TABLE attachments_media RENAME TO attachments;
          CREATE INDEX attachment_draft ON attachments(conversationId,messageId);
          CREATE TRIGGER attachment_message_scope BEFORE UPDATE OF messageId ON attachments WHEN NEW.messageId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM messages WHERE id=NEW.messageId AND conversationId=NEW.conversationId) BEGIN SELECT RAISE(ABORT,'attachment scope mismatch'); END;
          CREATE TABLE document_calls(id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, callId TEXT NOT NULL, fingerprint TEXT NOT NULL, messageId TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE, attachmentId TEXT REFERENCES attachments(id) ON DELETE SET NULL, action TEXT NOT NULL, page INTEGER, name TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, resultJson TEXT, UNIQUE(runId,ordinal,callId));
          INSERT INTO document_calls SELECT * FROM document_calls_media;
          DROP TABLE document_calls_media;
          CREATE TABLE IF NOT EXISTS directory_grants(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, root TEXT NOT NULL, createdAt INTEGER NOT NULL);
        `);
}

function migrateTo31(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS file_tool_receipts(
            runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL, callId TEXT NOT NULL, fingerprint TEXT NOT NULL,
            attachmentId TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
            PRIMARY KEY(runId,ordinal,callId));`);
}

/** Ordered install steps for an empty database. Version numbers exist only in this list. */
export function schemaMigrations(modules: MigrationModules): Migration[] {
  return [
    { version: 2, module: "core", migrate: migrateTo2 },
    { version: 3, module: "conversations", migrate: migrateTo3 },
    { version: 4, module: "emoji", migrate: migrateTo4 },
    { version: 5, module: "replies", migrate: migrateTo5 },
    { version: 6, module: "bots", migrate: migrateTo6 },
    { version: 7, module: "tools", migrate: migrateTo7 },
    { version: 8, module: "read-state", migrate: migrateTo8 },
    { version: 9, module: "attachments", migrate: migrateTo9 },
    { version: 10, module: "groups", migrate: () => modules.groups.migrate() },
    {
      version: 11,
      module: "avatars",
      migrate: () => modules.avatars.migrate(),
    },
    { version: 12, module: "skills", migrate: () => modules.skills.migrate() },
    {
      version: 13,
      module: "memory",
      migrate: () => modules.memory.migrate(),
    },
    {
      version: 14,
      module: "computers",
      migrate: (db) => retiredComputerSchema.computer(db),
    },
    {
      version: 15,
      module: "tool-calls",
      migrate: () => modules.toolCalls.migrate(),
    },
    {
      version: 16,
      module: "questions",
      migrate: () => modules.questions.migrate(),
    },
    {
      version: 17,
      module: "skill-tools",
      migrate: () => modules.skillTools.migrate(),
    },
    {
      version: 18,
      module: "deletions",
      migrate: () => modules.deletions.migrate(),
    },
    {
      version: 19,
      module: "sidebar",
      migrate: () => modules.sidebar.migrate(),
    },
    {
      version: 20,
      module: "documents",
      migrate: () => modules.documents.migrate(),
    },
    {
      version: 21,
      module: "documents",
      migrate: () => modules.documents.migrateOffice(),
    },
    {
      version: 22,
      module: "routines",
      migrate: () => modules.routines.repository.migrate(),
    },
    {
      version: 23,
      module: "templates",
      migrate: () => modules.templates.migrate(),
    },
    {
      version: 24,
      module: "template-tools",
      migrate: () => modules.templateTools.migrate(),
    },
    { version: 25, module: "messages", migrate: migrateTo25 },
    { version: 26, module: "attachments", migrate: migrateTo26 },
    {
      version: 27,
      module: "memory",
      migrate: () => modules.sharedMemory.migrate(),
    },
    {
      version: 28,
      module: "computers",
      migrate: (db) => retiredComputerSchema.maintenance(db),
    },
    {
      version: 29,
      module: "computers",
      migrate: (db) => retiredComputerSchema.maintenanceOperations(db),
    },
    {
      version: 30,
      module: "approval",
      migrate: (db) => retiredComputerSchema.approval(db),
    },
    { version: 31, module: "files", migrate: migrateTo31 },
    {
      version: 32,
      module: "approval-review",
      migrate: (db) => retiredComputerSchema.approvalReview(db),
    },
    {
      version: 33,
      module: "teaching",
      migrate: (db) => retiredComputerSchema.recordings(db),
    },
    { version: 34, module: "context", migrate: migrateConversationContext },
    {
      version: 35,
      module: "plugins",
      migrate: () => {
        modules.plugins.migrate();
        modules.pluginCalls.migrate();
      },
    },
    { version: 36, module: "cloud-chats", migrate: migrateCloudChats },
    { version: 37, module: "im", migrate: migrateIm },
    {
      version: 38,
      module: "im-history",
      migrate: (db) =>
        db.exec(
          "CREATE TABLE im_history_pages(roomId TEXT PRIMARY KEY,newest INTEGER NOT NULL,oldest INTEGER NOT NULL,hasOlder INTEGER NOT NULL)",
        ),
    },
    {
      version: 39,
      module: "im-delivery",
      migrate: (db) =>
        db.exec(
          "ALTER TABLE cloud_chat_collaboration_outbox ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0",
        ),
    },
    { version: 40, module: "relay", migrate: migrateRelay },
    { version: 41, module: "group-host", migrate: migrateGroupHost },
    { version: 42, module: "local-workspace", migrate: migrateLocalWorkspace },
  ];
}

export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  transaction: <T>(fn: () => T) => T,
  backupBeforeUpgrade = true,
) {
  assertMigrationRegistry(migrations);
  const version = z
    .object({ user_version: z.number() })
    .parse(db.prepare("PRAGMA user_version").get()).user_version;
  if (version > maxDatabaseVersion)
    throw new AppError(
      "unavailable",
      "数据库版本高于当前应用，请使用对应版本。",
    );
  if (version === maxDatabaseVersion) return;
  if (version !== 0 && version < minDatabaseVersion)
    throw new AppError(
      "unavailable",
      "不支持这份数据库的版本，原文件未更改。请使用支持该版本的应用导出数据。",
    );
  if (version !== 0 && backupBeforeUpgrade) saveMigrationBackup(db, version);
  // Table rebuilds retain references while foreign-key checking is deferred
  // until the complete schema is present, before the transaction can commit.
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    transaction(() => {
      let current = version;
      for (const migration of migrations) {
        if (current >= migration.version) continue;
        const fromVersion = current;
        migration.migrate(db, fromVersion);
        db.exec(`PRAGMA user_version=${migration.version}`);
        current = migration.version;
      }
      if (db.prepare("PRAGMA foreign_key_check").all().length)
        throw new AppError(
          "unavailable",
          "升级后的数据关联校验未通过，已保留原数据库。",
        );
    });
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}
