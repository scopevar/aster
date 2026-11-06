import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppError } from "../src/shared/core.js";
import { envelopeSchema, type Command } from "../src/shared/commands.js";
import type { EveryCommandHasHandler } from "../src/storage/commands/registry.js";
import { Store } from "../src/storage/store.js";

const handlersCoverCommands: EveryCommandHasHandler = true;
void handlersCoverCommands;

function command(value: Command, id = randomUUID()) {
  return envelopeSchema.parse({ id, command: value });
}

await test("replaying a command id returns the original result and a different fingerprint conflicts", () => {
  const directory = mkdtempSync(join(tmpdir(), "aster-commands-"));
  const store = new Store(join(directory, "db.sqlite"));
  try {
    const envelope = command({
      type: "bot.create",
      name: "Once",
      description: "same",
    });
    const first = store.execute(envelope);
    const second = store.execute(envelope);
    assert.deepEqual(second, first);
    assert.equal(store.views.snapshot({}).bots.length, 1);
    assert.throws(
      () =>
        store.execute({
          ...envelope,
          command: { type: "bot.create", name: "Other", description: "same" },
        }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "conflict" &&
        error.message === "相同命令编号不能用于不同操作。",
    );
    assert.equal(store.views.snapshot({}).bots.length, 1);
    assert.deepEqual(store.execute(envelope), first);
    for (const value of [
      { type: "agent.check" as const },
      { type: "worker.stop" as const },
      {
        type: "template.import" as const,
        payload: {
          format: 1 as const,
          name: "template",
          description: "",
          tags: "",
          language: "auto" as const,
          avatar: {
            shape: "blob" as const,
            color: "gray" as const,
            image: null,
          },
          skills: [],
          routines: [],
          plugins: [],
        },
      },
    ]) {
      assert.throws(
        () => store.execute(command(value)),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === "invalid_input" &&
          error.message === "该命令不属于存储接口。",
      );
    }
    assert.equal(store.views.snapshot({}).bots.length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
