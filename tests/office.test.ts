import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { inspectOfficeArchive } from "../src/documents/office-archive.js";
import { officeContent } from "../src/documents/office-content.js";
import { DocumentReader } from "../src/documents/reader.js";
import { DocumentSession } from "../src/documents/service.js";
import type { Command } from "../src/shared/commands.js";
import { officeLink } from "../src/shared/files/office.js";
import { Store } from "../src/storage/store.js";
import { officeZip, sampleWord, sampleWorkbook } from "./helpers/office.js";
const reader = () =>
  new DocumentReader(
    new URL("../dist/documents/pdf-worker.js", import.meta.url),
  );
const signal = () => new AbortController().signal;
const envelope = (command: Command) => ({
  id: randomUUID(),
  command,
});

await test("independently authored BIFF8 preserves real formula tokens, Unicode and zero without inventing a calculated result", async () => {
  const documents = reader();
  try {
    const bytes = await readFile(
      new URL("./fixtures/independent-formula.xls", import.meta.url),
    );
    const range = await documents.readOffice(
      bytes,
      "independent-formula.xls",
      "table",
      {
        action: "table.range",
        sheet: 0,
        row: 1,
        column: 1,
        rows: 3,
        columns: 3,
      },
      signal(),
    );
    assert.ok(range.action === "table.range");
    assert.equal(range.cells[0]?.[0]?.value, "BIFF8_真实公式");
    assert.equal(range.cells[1]?.[0]?.value, 0);
    assert.equal(range.cells[1]?.[2]?.formula, "A2+B2");
    // xlwt writes an empty-string cached formula result; it must not be evaluated into 42.
    assert.equal(range.cells[1]?.[2]?.value, "");
    assert.equal(range.cells[2]?.[0]?.value, "第一行\n第二行");
  } finally {
    await documents.close();
  }
});

await test("real DOCX conversion preserves Chinese structure, text pagination and embedded pixels while blocking unsafe links", async () => {
  const documents = reader(),
    token = randomUUID(),
    bytes = sampleWord(token);
  try {
    const result = await documents.readOffice(
      bytes,
      "proof.docx",
      "docx",
      { action: "word.preview" },
      signal(),
    );
    assert.equal(result.action, "word.preview");
    if (result.action !== "word.preview") throw Error("wrong result");
    assert.ok(JSON.stringify(result.nodes).includes(token));
    assert.ok(JSON.stringify(result.nodes).includes('"tag":"strong"'));
    assert.ok(JSON.stringify(result.nodes).includes('"tag":"table"'));
    assert.ok(!JSON.stringify(result.nodes).includes("javascript:"));
    assert.match(result.warnings.join("\n"), /不安全/);
    assert.ok(result.images[0]?.data);
    const pixel = await sharp(Buffer.from(result.images[0].data, "base64"))
      .extract({ left: 70, top: 150, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();
    assert.deepEqual([...pixel], [0, 0, 255]);
    const text = await documents.readOffice(
      bytes,
      "proof.docx",
      "docx",
      { action: "word.text", offset: 0, length: 7 },
      signal(),
    );
    assert.ok(text.action === "word.text");
    assert.equal(text.text, token.slice(0, 7));
    assert.equal(text.next, 7);
    const rest = await documents.readOffice(
      bytes,
      "proof.docx",
      "docx",
      { action: "word.text", offset: 7, length: 120000 },
      signal(),
    );
    assert.ok(rest.action === "word.text");
    assert.ok((text.text + rest.text).includes(token));
    assert.ok(rest.text.includes("金额\t42"));
    assert.equal(rest.next, null);
    await assert.rejects(
      documents.readOffice(
        bytes,
        "proof.docx",
        "docx",
        { action: "word.image", index: 9 },
        signal(),
      ),
      /不存在/,
    );
    await assert.rejects(
      documents.readOffice(
        Buffer.from("broken"),
        "broken.docx",
        "docx",
        { action: "word.info" },
        signal(),
      ),
      /无法解析/,
    );
  } finally {
    await documents.close();
  }
});
await test("actual XLSX and delimited readers preserve coordinates, zero, formula cache, newlines and separate sheets", async () => {
  const documents = reader(),
    token = randomUUID(),
    bytes = sampleWorkbook(token, 300);
  try {
    const info = await documents.readOffice(
      bytes,
      "proof.xlsx",
      "table",
      { action: "table.info" },
      signal(),
    );
    assert.ok(info.action === "table.info");
    assert.deepEqual(
      info.sheets.map((sheet) => sheet.name),
      ["数据", "明细"],
    );
    assert.equal(info.sheets[0]?.rows, 300);
    const range = await documents.readOffice(
      bytes,
      "proof.xlsx",
      "table",
      {
        action: "table.range",
        sheet: 0,
        row: 2,
        column: 1,
        rows: 2,
        columns: 3,
      },
      signal(),
    );
    assert.ok(range.action === "table.range");
    assert.equal(range.cells[0]?.[0]?.value, token);
    assert.equal(range.cells[0]?.[1]?.value, 0);
    assert.equal(range.cells[0]?.[1]?.text, "0");
    assert.equal(range.cells[0]?.[2]?.formula, "SUM(B2,42)");
    assert.equal(range.cells[0]?.[2]?.value, 42);
    assert.equal(range.cells[1]?.[1]?.text, "第一行\n第二行");
    assert.equal(range.cells[1]?.[2]?.formula, "1+2");
    assert.equal(range.cells[1]?.[2]?.value, null);
    const tail = await documents.readOffice(
      bytes,
      "proof.xlsx",
      "table",
      {
        action: "table.range",
        sheet: 0,
        row: 299,
        column: 1,
        rows: 2,
        columns: 2,
      },
      signal(),
    );
    assert.ok(tail.action === "table.range");
    assert.equal(tail.cells[1]?.[1]?.value, 300);
    const second = await documents.readOffice(
      bytes,
      "proof.xlsx",
      "table",
      {
        action: "table.range",
        sheet: 1,
        row: 2,
        column: 1,
        rows: 1,
        columns: 1,
      },
      signal(),
    );
    assert.ok(second.action === "table.range");
    assert.equal(second.cells[0]?.[0]?.text, token + "_SECOND");
    for (const extension of ["csv", "tsv"]) {
      const sep = extension === "csv" ? "," : "\t";
      const data = Buffer.from(
        `名称${sep}备注\r\n"甲,乙"${sep}"第一行\n第二行"\r\n=1+2${sep}0001`,
      );
      const parsed = await documents.readOffice(
        data,
        `test.${extension}`,
        "table",
        {
          action: "table.range",
          sheet: 0,
          row: 2,
          column: 1,
          rows: 2,
          columns: 2,
        },
        signal(),
      );
      assert.ok(parsed.action === "table.range");
      assert.equal(parsed.cells[0]?.[1]?.text, "第一行\n第二行");
      assert.equal(parsed.cells[1]?.[0]?.value, "=1+2");
      assert.equal(parsed.cells[1]?.[0]?.formula, null);
      assert.equal(parsed.cells[1]?.[1]?.value, "0001");
    }
  } finally {
    await documents.close();
  }
});
await test("Office archive guards reject expansion bombs, traversal and corruption; HTML projection cannot create executable nodes", async () => {
  await assert.rejects(
    inspectOfficeArchive(
      officeZip({ "huge.xml": "a".repeat(17 * 1024 * 1024) }),
    ),
    /超过/,
  );
  await assert.rejects(
    inspectOfficeArchive(officeZip({ "../escape.xml": "bad" })),
    /invalid relative path/,
  );
  const broken = officeZip({ "proof.xml": "hello" });
  broken.writeUInt32LE(
    123,
    broken.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 16,
  );
  await assert.rejects(inspectOfficeArchive(broken), /校验失败/);
  const result = officeContent(
    '<script>bad</script><svg onload="bad()"/><p onclick="bad()">safe<a href="javascript:bad()">label</a><img src="file:///etc/passwd"/></p>',
  );
  assert.ok(!JSON.stringify(result.nodes).includes("javascript:"));
  assert.ok(!JSON.stringify(result.nodes).includes("file:"));
  assert.ok(result.warnings.length >= 2);
  assert.match(result.text, /safe/);
  for (const value of [
    "javascript:alert(1)",
    "file:///C:/secret",
    "https://user:password@example.com",
    "data:text/html,test",
  ])
    assert.equal(officeLink(value), null);
  const documents = reader(),
    abort = new AbortController();
  try {
    const task = documents.readOffice(
      sampleWorkbook("cancel", 3000),
      "cancel.xlsx",
      "table",
      { action: "table.info" },
      abort.signal,
    );
    const rejected = assert.rejects(task, { name: "AbortError" });
    abort.abort();
    await rejected;
    assert.equal(
      (
        await documents.readOffice(
          sampleWorkbook("after"),
          "after.xlsx",
          "table",
          { action: "table.info" },
          signal(),
        )
      ).action,
      "table.info",
    );
  } finally {
    await documents.close();
  }
});
await test("Office delivered scope keeps unsent drafts out of the shared document session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-office-")),
    path = join(directory, "db.sqlite"),
    documents = reader();
  const store = new Store(path);
  let session: DocumentSession | undefined;
  try {
    const bot = store.execute(
      envelope({ type: "bot.create", name: "Office", description: "" }),
    );
    assert.ok(bot.conversationId);
    const botId = bot.conversationId;
    const word = store.files.registerAttachment(
      { id: randomUUID(), conversationId: botId, name: "real.docx" },
      sampleWord("DELIVERED"),
    );
    store.execute(
      envelope({
        type: "message.send",
        conversationId: botId,
        text: "read",
        attachmentIds: [word.id],
      }),
    );
    const active = store.runs.claim();
    assert.ok(active);
    const draft = store.files.registerAttachment(
      { id: randomUUID(), conversationId: botId, name: "draft.xlsx" },
      sampleWorkbook("PRIVATE"),
    );
    session = new DocumentSession(store, documents, active);
    await assert.rejects(
      async () =>
        session!.request(
          {
            callId: "draft",
            operation: { action: "table.info", id: draft.id },
          },
          signal(),
        ),
      /明确共享/,
    );
    const received = await session.request(
      {
        callId: "word",
        operation: {
          action: "word.text",
          id: word.id,
          offset: 0,
          length: 120000,
        },
      },
      signal(),
    );
    assert.ok(received.action === "word.text");
    assert.match(received.text, /DELIVERED/);
    assert.equal(
      (
        await session.request(
          {
            callId: "word",
            operation: {
              action: "word.text",
              id: word.id,
              offset: 0,
              length: 120000,
            },
          },
          signal(),
        )
      ).action,
      "word.text",
    );
  } finally {
    await session?.close();
    await documents.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("group Office scope excludes drafts, private attachments and queued future messages, then revokes finished turns", async () => {
  const store = new Store(":memory:");
  try {
    const a = store.execute(
        envelope({ type: "bot.create", name: "A", description: "" }),
      ),
      b = store.execute(
        envelope({ type: "bot.create", name: "B", description: "" }),
      );
    assert.ok(a.id && a.conversationId && b.id);
    const group = store.execute(
      envelope({ type: "group.prepare", memberIds: [a.id, b.id] }),
    );
    assert.ok(group.conversationId);
    let serial = 0;
    const upload = (conversationId: string) =>
      store.files.registerAttachment(
        { id: randomUUID(), conversationId, name: "scope.docx" },
        sampleWord("OFFICE_" + serial++),
      );
    const received = upload(group.conversationId),
      draft = upload(group.conversationId),
      privateFile = upload(a.conversationId);
    store.execute(
      envelope({
        type: "group.start",
        conversationId: group.conversationId,
        memberIds: [a.id, b.id],
        text: "read shared",
        attachmentIds: [received.id],
      }),
    );
    const parent = store.runs.claim();
    assert.ok(parent);
    const turn = store.runs.nextGroupTurn(parent);
    assert.ok(turn);
    const future = upload(group.conversationId);
    store.execute(
      envelope({
        type: "message.send",
        conversationId: group.conversationId,
        recipientIds: [a.id],
        text: "future",
        attachmentIds: [future.id],
      }),
    );
    assert.deepEqual(
      store.documentOperations
        .documentList(turn)
        .documents.map((file) => file.id),
      [received.id],
    );
    for (const id of [draft.id, privateFile.id, future.id])
      assert.throws(
        () => store.documentOperations.documentContent(turn, id),
        /未向当前运行/,
      );
    store.runs.finishGroupTurn(turn, "completed", null);
    assert.throws(
      () => store.documentOperations.documentContent(turn, received.id),
      /运行已经结束/,
    );
    const second = store.runs.nextGroupTurn(parent);
    assert.ok(second);
    assert.deepEqual(
      store.documentOperations
        .documentList(second)
        .documents.map((file) => file.id),
      [received.id],
    );
  } finally {
    store.close();
  }
});
