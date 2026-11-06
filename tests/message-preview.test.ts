import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { messagePreview } from "../src/storage/chat/message-preview.js";
import { Store } from "../src/storage/store.js";

await test("previews extract Markdown text without stripping literal punctuation", () => {
  const examples = [
    ["我现在是 **Codex，基于 GPT-5**", "我现在是 Codex，基于 GPT-5"],
    ["**粗体 _嵌套_** 和 ~~删除~~", "粗体 嵌套 和 删除"],
    [String.raw`\*文字\* 和 \_文字\_`, "*文字* 和 _文字_"],
    [
      "2 * 3 和 snake_case 和 未闭合 **文字",
      "2 * 3 和 snake_case 和 未闭合 **文字",
    ],
    ["`a * b 和 **原文**`", "a * b 和 **原文**"],
    ["```ts\nconst x = '**原文**';\n```", "const x = '**原文**';"],
    ["[**说明**](https://example.org)", "说明"],
    ["[说明][ref]\n\n[ref]: https://example.org", "说明"],
    ["![示意图](https://example.org/a.png)", "[图片：示意图]"],
    ["# 标题\n\n> 引用\n\n- 第一项\n- 第二项", "标题 引用 第一项 第二项"],
    ["| A | B |\n| - | - |\n| 1 | 2 |", "A B 1 2"],
    ["前文  \n后文\n\n---\n\n结尾", "前文 后文 结尾"],
    ["<script>hidden()</script>\n\n保留 <b>文字</b>", "保留 文字"],
    [String.raw`公式 \(x_1 * y_2\) 和 $a_b$`, "公式 x_1 * y_2 和 a_b"],
    ["&amp; &#42;", "& *"],
    ["", ""],
  ];
  for (const [source, expected] of examples) {
    assert.ok(source !== undefined);
    assert.equal(messagePreview(source), expected, source);
  }
});

await test("previews parse complete source before truncating visible text", () => {
  const content = "中".repeat(300);
  assert.equal(messagePreview(`**${content}**`), "中".repeat(240));
  assert.equal(
    messagePreview(`[${content}](https://example.org)`),
    "中".repeat(240),
  );
  assert.equal(
    messagePreview(`[说明][ref]\n\n${content}\n\n[ref]: https://example.org`),
    `说明 ${content}`.slice(0, 240),
  );
  assert.equal(
    messagePreview(`**${"中".repeat(239)}😀结尾**`),
    `${"中".repeat(239)}😀`,
  );
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "aster-preview-"));
  const store = new Store(join(directory, "db.sqlite"));
  const execute = (command: Command) =>
    store.execute(envelopeSchema.parse({ id: randomUUID(), command }));
  const conversationId = execute({
    type: "bot.create",
    name: "Preview",
    description: "",
  }).conversationId;
  assert.ok(conversationId);
  return { directory, store, execute, conversationId };
}

await test("snapshots return plain previews while preserving message source and refreshing streamed edits", () => {
  const { directory, store, execute, conversationId } = fixture();
  try {
    assert.equal(store.views.snapshot({}).conversations[0]?.preview, "");
    const content = "中".repeat(300);
    const source = `**${content}**`;
    execute({ type: "message.send", conversationId, text: source });
    const first = store.views.snapshot({ conversationId });
    assert.equal(first.conversations[0]?.preview, content.slice(0, 240));
    assert.equal(first.messages[0]?.text, source);
    assert.equal(
      store.views.snapshot({}).conversations[0]?.preview,
      content.slice(0, 240),
    );

    const job = store.runs.claim();
    assert.ok(job);
    store.runs.output.writeText(job, "reply", "**未闭合", false);
    assert.equal(
      store.views.snapshot({}).conversations[0]?.preview,
      "**未闭合",
    );
    store.runs.output.writeText(job, "reply", "**", false);
    assert.equal(store.views.snapshot({}).conversations[0]?.preview, "未闭合");
    store.runs.output.writeText(job, "reply", "`a * b`", true);
    const final = store.views.snapshot({ conversationId });
    assert.equal(final.conversations[0]?.preview, "a * b");
    assert.equal(final.messages.at(-1)?.text, "`a * b`");
    store.runs.finish(job.id, "completed", null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("attachment-only previews retain literal Markdown characters in filenames", () => {
  const { directory, store, execute, conversationId } = fixture();
  try {
    const attachment = store.files.registerAttachment(
      { id: randomUUID(), conversationId, name: "[report](draft)_v1_.txt" },
      Buffer.from("content"),
    );
    execute({
      type: "message.send",
      conversationId,
      text: "",
      attachmentIds: [attachment.id],
    });
    assert.equal(
      store.views.snapshot({}).conversations[0]?.preview,
      "附件：[report](draft)_v1_.txt",
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
