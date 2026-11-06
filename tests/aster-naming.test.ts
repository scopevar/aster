import assert from "node:assert/strict";
import { test } from "node:test";
import { isPiSession } from "../src/agent/pi-sessions.js";
await test("only explicitly scoped Pi session identities can be restored", () => {
  assert.equal(isPiSession("provider-thread"), false);
  assert.equal(isPiSession("aster-session:legacy"), false);
  assert.equal(isPiSession("pi:v1:" + "a".repeat(64) + ":Zm9vLmpzb25s"), true);
});
