import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DirectoryConsent } from "../src/desktop/ipc/directory-consent.js";
import { AppError } from "../src/shared/core.js";
import {
  desktopEnvelopeSchema,
  storedDesktopEnvelopeSchema,
} from "../src/shared/desktop/desktop-commands.js";
import { Store } from "../src/storage/store.js";

const unauthorized = (error: unknown) =>
  error instanceof AppError && error.code === "unauthorized";

await test("stored commands drop old cache metadata while strict IPC and native directory consent remain enforced", () => {
  const request = {
    version: 19,
    id: randomUUID(),
    command: { type: "bot.create", name: "pending", description: "" },
  };
  assert.deepEqual(storedDesktopEnvelopeSchema.parse(request), {
    id: request.id,
    command: request.command,
  });
  assert.equal(desktopEnvelopeSchema.safeParse(request).success, false);
  assert.equal(
    storedDesktopEnvelopeSchema.safeParse({
      ...request,
      command: {
        type: "directory.attach",
        conversationId: randomUUID(),
        root: "/home/user/.ssh",
      },
    }).success,
    false,
  );
});

await test("renderer directory commands reject arbitrary paths, forged credentials and extra scope fields", () => {
  const consent = new DirectoryConsent();
  const envelope = { id: randomUUID() };
  const conversationId = randomUUID();
  assert.equal(
    desktopEnvelopeSchema.safeParse({
      ...envelope,
      command: {
        type: "directory.attach",
        conversationId,
        root: "/home/user/.ssh",
      },
    }).success,
    false,
  );
  const forged = desktopEnvelopeSchema.parse({
    ...envelope,
    command: {
      type: "directory.attach",
      conversationId,
      credential: randomUUID(),
    },
  });
  assert.throws(() => consent.authorize(forged, 1), unauthorized);
  assert.equal(
    desktopEnvelopeSchema.safeParse({ ...forged, expectedEpoch: randomUUID() })
      .success,
    false,
  );
});

await test("dialog credentials bind the path, conversation and window; redemption permits only the original request retry", () => {
  const consent = new DirectoryConsent();
  const conversationId = randomUUID(),
    epoch = randomUUID();
  const credential = consent.issue(
    { root: "/chosen", conversationId, epoch, owner: 7 },
    1000,
  );
  const request = desktopEnvelopeSchema.parse({
    id: randomUUID(),
    command: { type: "directory.attach", conversationId, credential },
  });
  assert.throws(() => consent.authorize(request, 8, 1000), unauthorized);
  assert.throws(
    () =>
      consent.authorize(
        {
          ...request,
          command: {
            ...request.command,
            type: "directory.attach",
            conversationId: randomUUID(),
            credential,
          },
        },
        7,
        1000,
      ),
    unauthorized,
  );
  const forwarded = consent.authorize(request, 7, 1000);
  assert.deepEqual(forwarded.command, {
    type: "directory.attach",
    conversationId,
    root: "/chosen",
  });
  assert.equal(forwarded.expectedEpoch, epoch);
  assert.deepEqual(consent.authorize(request, 7, 1001), forwarded);
  assert.throws(
    () => consent.authorize({ ...request, id: randomUUID() }, 7, 1001),
    unauthorized,
  );
  assert.throws(() => consent.authorize(request, 7, 301000), unauthorized);
  consent.clear();
  assert.throws(() => consent.authorize(request, 7, 1001), unauthorized);
});

await test("worker rejects a stale consent inside the transaction and preserves same-ID grant replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-consent-"));
  const store = new Store(join(directory, "db.sqlite"));
  try {
    const bot = store.execute({
      id: randomUUID(),
      command: { type: "bot.create", name: "consent", description: "" },
    });
    assert.ok(bot.conversationId);
    const consent = new DirectoryConsent();
    const credential = consent.issue({
      root: directory,
      conversationId: bot.conversationId,
      epoch: store.cursor().epoch,
      owner: 1,
    });
    const request = desktopEnvelopeSchema.parse({
      id: randomUUID(),
      command: {
        type: "directory.attach",
        conversationId: bot.conversationId,
        credential,
      },
    });
    const forwarded = consent.authorize(request, 1);
    const before = store.cursor();
    assert.throws(
      () => store.execute({ ...forwarded, expectedEpoch: randomUUID() }),
      unauthorized,
    );
    assert.deepEqual(store.cursor(), before);
    const result = store.execute(forwarded);
    assert.deepEqual(store.execute(consent.authorize(request, 1)), result);
    const conversation = store.views
      .snapshot({ conversationId: bot.conversationId })
      .conversations.find((c) => c.id === bot.conversationId);
    assert.equal(conversation?.directoryGrants.length, 1);
    assert.equal(conversation?.directoryGrants[0]?.root, directory);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
