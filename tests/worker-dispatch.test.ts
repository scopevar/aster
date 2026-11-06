import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandSchema,
  envelopeSchema,
  type Command,
} from "../src/shared/commands.js";
import { workerRoutes } from "../src/shared/protocol.js";
import {
  routeMatches,
  uniqueRoutes,
  bareRoute,
} from "../src/worker/http-routes.js";
import { asyncCommandKind } from "../src/worker/dispatch.js";

const botId = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";

function command(value: unknown): Command {
  return commandSchema.parse(value);
}

const templatePayload = {
  format: 1,
  name: "模板",
  description: "",
  tags: "",
  language: "auto",
  avatar: {
    shape: "hexagon",
    color: "cyan",
    image: null,
  },
  skills: [],
  routines: [],
};

await test("worker routes match direct paths and still reject duplicates", () => {
  const health = bareRoute("GET", workerRoutes.health, async () => {});
  assert.equal(routeMatches(health, "GET", "/health"), true);
  assert.equal(routeMatches(health, "POST", "/health"), false);
  assert.equal(routeMatches(health, "GET", "/health/extra"), false);
  assert.throws(() => uniqueRoutes([health, health]), /重复的后台路由/);
});
await test("worker command envelopes carry identity and validated commands without a version", () => {
  const request = { id, command: { type: "worker.stop" } };
  assert.deepEqual(envelopeSchema.parse(request), request);
  assert.equal(
    envelopeSchema.safeParse({ ...request, version: 20 }).success,
    false,
  );
  assert.equal(
    envelopeSchema.safeParse({ ...request, arbitrary: true }).success,
    false,
  );
});

await test("async command dispatch matches import and avatar saves", () => {
  assert.equal(
    asyncCommandKind(
      command({
        type: "template.import",
        payload: templatePayload,
      }),
    ),
    "avatar",
  );
  assert.equal(
    asyncCommandKind(
      command({
        type: "template.save",
        id,
        revision: 1,
        payload: {
          ...templatePayload,
          avatar: { ...templatePayload.avatar, image: "YQ==" },
        },
      }),
    ),
    "avatar",
  );
  assert.equal(
    asyncCommandKind(
      command({
        type: "template.save",
        id,
        revision: 1,
        payload: templatePayload,
      }),
    ),
    undefined,
  );
  assert.equal(
    asyncCommandKind(
      command({
        type: "bot.avatar.image",
        botId,
        revision: 0,
        data: "YQ==",
      }),
    ),
    "avatar",
  );
  assert.equal(asyncCommandKind(command({ type: "agent.check" })), undefined);
  assert.equal(asyncCommandKind(command({ type: "worker.stop" })), undefined);
});
