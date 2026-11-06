import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import { Store } from "../src/storage/store.js";

function execute(store: Store, command: Command) {
  return store.execute(envelopeSchema.parse({ id: randomUUID(), command }));
}

await test("saved-message search has bounded lossless cursors and locates full history across conversations", () => {
  const directory = mkdtempSync(join(tmpdir(), "aster-message-search-"));
  const store = new Store(join(directory, "db.sqlite"));
  try {
    const first = execute(store, {
      type: "bot.create",
      name: "甲",
      description: "",
    }).conversationId;
    const second = execute(store, {
      type: "bot.create",
      name: "乙",
      description: "",
    }).conversationId;
    assert.ok(first && second);
    const ids: string[] = [];
    for (let index = 0; index < 121; index++) {
      const result = execute(store, {
        type: "message.send",
        conversationId: first,
        text: `中文针 ${index} EnglishNeedle`,
      });
      assert.ok(result.id);
      ids.push(result.id);
      execute(store, { type: "run.cancel", runId: result.id });
    }
    const other = execute(store, {
      type: "message.send",
      conversationId: second,
      text: "中文针 hidden",
    });
    assert.ok(other.id);
    execute(store, {
      type: "conversation.update",
      conversationId: second,
      hidden: true,
      pinned: false,
    });
    const seen = new Set<string>();
    let before: number | undefined;
    let pages = 0;
    do {
      const result = store.views.searchMessages({
        version: 1,
        text: "中文针",
        ...(before ? { before } : {}),
      });
      assert.ok(result.scanned <= 500);
      assert.ok(result.hits.length <= 50);
      for (const hit of result.hits) {
        assert.equal(hit.conversationId, first);
        assert.match(hit.excerpt, /中文针/);
        assert.equal(seen.has(hit.messageId), false);
        seen.add(hit.messageId);
      }
      before = result.nextBefore ?? undefined;
      pages++;
    } while (before);
    assert.equal(pages, 3);
    assert.equal(seen.size, 121);
    assert.equal(
      store.views.searchMessages({ version: 1, text: "englishneedle" }).hits
        .length,
      50,
    );

    const oldest = store.views.searchMessages({ version: 1, text: "中文针 0" })
      .hits[0];
    assert.ok(oldest);
    const around = store.views.messageHistory({
      version: 1,
      direction: "around",
      conversationId: first,
      messageId: oldest.messageId,
    });
    assert.equal(around.messages[0]?.id, oldest.messageId);
    assert.equal(around.hasOlder, false);
    assert.equal(around.hasNewer, true);
    assert.equal(around.messages.length, 51);
    const next = store.views.messageHistory({
      version: 1,
      direction: "after",
      conversationId: first,
      sequence: around.messages.at(-1)!.sequence,
    });
    assert.equal(next.messages.length, 70);
    assert.equal(next.hasNewer, false);
    const previous = store.views.messageHistory({
      version: 1,
      direction: "before",
      conversationId: first,
      sequence: next.messages[0]!.sequence,
    });
    assert.equal(previous.messages.length, 51);
    assert.throws(
      () =>
        store.views.messageHistory({
          version: 1,
          direction: "around",
          conversationId: second,
          messageId: oldest.messageId,
        }),
      /不可查看/,
    );
    assert.throws(
      () =>
        store.views.messageHistory({
          version: 1,
          direction: "around",
          conversationId: first,
          messageId: randomUUID(),
        }),
      /不存在/,
    );
    for (let index = 0; index < 500; index++) {
      const result = execute(store, {
        type: "message.send",
        conversationId: first,
        text: `无匹配 ${index}`,
      });
      execute(store, { type: "run.cancel", runId: result.id! });
    }
    const emptyPage = store.views.searchMessages({
      version: 1,
      text: "中文针 0",
    });
    assert.equal(emptyPage.scanned, 500);
    assert.equal(emptyPage.hits.length, 0);
    assert.ok(emptyPage.nextBefore);
    const resumed = store.views.searchMessages({
      version: 1,
      text: "中文针 0",
      before: emptyPage.nextBefore,
    });
    assert.equal(resumed.hits[0]?.messageId, oldest.messageId);
    execute(store, {
      type: "conversation.update",
      conversationId: second,
      hidden: false,
      pinned: false,
    });
    const soonDeleted = store.views.searchMessages({
      version: 1,
      text: "hidden",
      before: emptyPage.nextBefore,
    }).hits[0];
    assert.ok(soonDeleted);
    const secondBot = store.views
      .snapshot({})
      .conversations.find((item) => item.id === second)?.botId;
    assert.ok(secondBot);
    execute(store, {
      type: "entity.delete",
      kind: "bot",
      targetId: secondBot,
      expectedName: "乙",
    });
    assert.equal(
      store.views.searchMessages({
        version: 1,
        text: "hidden",
        before: emptyPage.nextBefore,
      }).hits.length,
      0,
    );
    assert.throws(
      () =>
        store.views.messageHistory({
          version: 1,
          direction: "around",
          conversationId: second,
          messageId: soonDeleted.messageId,
        }),
      /不可查看/,
    );
    assert.equal(ids.length, 121);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
