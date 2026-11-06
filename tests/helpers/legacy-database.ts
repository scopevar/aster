import { createHash, randomUUID } from "node:crypto";
import { copyFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

/** Historical schemas are immutable fixtures, populated through their common SQL contract. */
export async function legacyDatabase(path: string, version: 9 | 24 | 32) {
  await copyFile(
    new URL(`../fixtures/schema/v${version}.sqlite`, import.meta.url),
    path,
  );
  const botId = randomUUID(),
    conversationId = randomUUID();
  const runId = randomUUID(),
    pendingRunId = randomUUID();
  const messageId = randomUUID(),
    attachmentId = randomUUID();
  const bytes = Buffer.from(`历史附件 v${version}`);
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      "INSERT INTO bots(id,name,description,createdAt) VALUES(?,?,?,?)",
    ).run(botId, "升级前的 Bot", "保留说明", 1700000000000);
    db.prepare(
      "INSERT INTO conversations(id,botId,createdAt,draft) VALUES(?,?,?,?)",
    ).run(conversationId, botId, 1700000000000, "升级前的草稿");
    const insertRun = db.prepare(
      "INSERT INTO runs(id,botId,conversationId,status,createdAt) VALUES(?,?,?,?,?)",
    );
    insertRun.run(runId, botId, conversationId, "completed", 1700000000000);
    insertRun.run(
      pendingRunId,
      botId,
      conversationId,
      "running",
      1700000000001,
    );
    db.prepare(
      "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId) VALUES(?,?,?,?,?,?,?)",
    ).run(
      messageId,
      botId,
      conversationId,
      "user",
      "升级前的消息",
      1700000000000,
      runId,
    );
    db.prepare(
      "INSERT INTO attachments(id,conversationId,name,kind,mime,size,hash,createdAt,messageId,data) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      attachmentId,
      conversationId,
      "历史.txt",
      "text",
      "text/plain",
      bytes.length,
      createHash("sha256").update(bytes).digest("hex"),
      1700000000000,
      messageId,
      bytes,
    );
  } finally {
    db.close();
  }
  return {
    botId,
    conversationId,
    runId,
    pendingRunId,
    messageId,
    attachmentId,
    bytes,
  };
}
