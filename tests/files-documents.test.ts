import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DocumentReader } from "../src/documents/reader.js";
import { FileSession } from "../src/files/session.js";
import type { Command } from "../src/shared/commands.js";
import type {
  OfficeKind,
  OfficeOperation,
} from "../src/shared/files/office.js";
import type { FileRequest } from "../src/shared/files/files.js";
import { Store } from "../src/storage/store.js";
import { ToolService } from "../src/tools/service.js";
import { sampleWord, sampleWorkbook } from "./helpers/office.js";
import { samplePdf } from "./helpers/pdf.js";

const command = (command: Command) => ({
  id: randomUUID(),
  command,
});
const workerUrl = new URL(
  "../dist/documents/office-worker.js",
  import.meta.url,
);

await test("granted directory documents use the real Word/table parsers and reject retired host PDF operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-directory-docs-"));
  const store = new Store(join(directory, "db.sqlite"));
  const reader = new DocumentReader(workerUrl);
  let files: FileSession | undefined;
  try {
    const root = join(directory, "granted");
    await mkdir(root);
    const proof = randomUUID();
    await writeFile(join(root, "proof.pdf"), samplePdf(proof, "scan"));
    await writeFile(join(root, "proof.docx"), sampleWord(proof));
    await writeFile(join(root, "proof.xlsx"), sampleWorkbook(proof));
    await writeFile(join(root, "bad.pdf"), "not a pdf");
    const created = store.execute(
      command({ type: "bot.create", name: "Reader", description: "" }),
    );
    assert.ok(created.conversationId);
    const grant = store.execute(
      command({
        type: "directory.attach",
        conversationId: created.conversationId,
        root,
      }),
    );
    assert.ok(grant.id);
    store.execute(
      command({
        type: "message.send",
        conversationId: created.conversationId,
        text: "read docs",
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    files = new FileSession(store, job, undefined, reader);
    const read = (
      path: string,
      operation: Extract<
        FileRequest["operation"],
        { action: "document" }
      >["operation"],
    ) =>
      files!.request(
        {
          callId: randomUUID(),
          operation: { action: "document", grantId: grant.id, path, operation },
        },
        new AbortController().signal,
      );
    await assert.rejects(
      read("proof.pdf", { action: "text", page: 1 }),
      /Python/,
    );
    const word = await read("proof.docx", {
      action: "word.text",
      offset: 0,
      length: 120000,
    });
    assert.ok(word.action === "document" && word.result.action === "word.text");
    assert.ok(JSON.stringify(word.result).includes(proof));
    const table = await read("proof.xlsx", {
      action: "table.range",
      sheet: 0,
      row: 1,
      column: 1,
      rows: 5,
      columns: 5,
    });
    assert.ok(
      table.action === "document" && table.result.action === "table.range",
    );
    assert.ok(JSON.stringify(table.result).includes(proof));
    await assert.rejects(read("bad.pdf", { action: "info" }), /PDF/);
    await assert.rejects(read("proof.docx", { action: "info" }), /word|table/);
    await assert.rejects(read("proof.pdf", { action: "word.info" }), /PDF/);
    assert.equal(
      store.views
        .snapshot({ conversationId: job.conversationId })
        .messages.flatMap((m) => m.attachments).length,
      0,
      "reading a directory must not silently retain the source as an attachment",
    );
  } finally {
    await files?.close();
    await reader.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("revoking a grant cancels the actual directory parser through ToolService and drains it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-directory-revoke-"));
  const store = new Store(join(directory, "db.sqlite"));
  let started: () => void = () => {};
  const parsing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let actualSignal: AbortSignal | undefined;
  class ObservedReader extends DocumentReader {
    override readOffice(
      bytes: Uint8Array,
      name: string,
      kind: OfficeKind,
      operation: OfficeOperation,
      signal: AbortSignal,
    ) {
      actualSignal = signal;
      const result = super.readOffice(bytes, name, kind, operation, signal);
      started();
      return result;
    }
  }
  const reader = new ObservedReader(workerUrl);
  const tools = new ToolService(store, 42000, reader);
  let scope: ReturnType<ToolService["open"]> | undefined;
  try {
    const root = join(directory, "granted");
    await mkdir(root);
    await writeFile(join(root, "proof.docx"), sampleWord("proof"));
    const created = store.execute(
      command({ type: "bot.create", name: "Reader", description: "" }),
    );
    assert.ok(created.conversationId);
    const grant = store.execute(
      command({
        type: "directory.attach",
        conversationId: created.conversationId,
        root,
      }),
    );
    assert.ok(grant.id);
    store.execute(
      command({
        type: "message.send",
        conversationId: created.conversationId,
        text: "read",
      }),
    );
    const job = store.runs.claim();
    assert.ok(job);
    scope = tools.open(job, new AbortController().signal);
    const reading = tools.files(
      scope.connection.token,
      {
        callId: "read",
        operation: {
          action: "document",
          grantId: grant.id,
          path: "proof.docx",
          operation: { action: "word.info" },
        },
      },
      new AbortController().signal,
    );
    const rejected = assert.rejects(reading, /撤销/);
    await parsing;
    store.execute(
      command({
        type: "directory.revoke",
        conversationId: created.conversationId,
        id: grant.id,
      }),
    );
    tools.wake();
    assert.equal(actualSignal?.aborted, true);
    await rejected;
    await scope.close();
    assert.equal(
      (
        await reader.readOffice(
          sampleWord("STILL_AVAILABLE"),
          "proof.docx",
          "docx",
          { action: "word.info" },
          new AbortController().signal,
        )
      ).action,
      "word.info",
    );
  } finally {
    await scope?.close();
    await reader.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
