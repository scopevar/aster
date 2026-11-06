import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { templateEditCacheSchema } from "../src/ui/features/templates/template-edit-cache.js";
import { templateDraftSchema } from "../src/shared/templates/templates.js";

await test("incomplete edits restore without weakening template file validation", () => {
  const draft = {
    id: randomUUID(),
    revision: 1,
    updatedAt: 0,
    payload: {
      format: 1,
      name: "",
      description: "未完成正文",
      tags: "",
      language: "auto",
      avatar: { shape: "hexagon", color: "cyan", image: null },
      plugins: [],
      skills: [{ name: "", description: "", body: "部分正文" }],
      routines: [
        {
          name: "",
          prompt: "",
          schedule: { kind: "cron", expression: "", timeZone: "" },
        },
      ],
    },
  };
  assert.deepEqual(templateEditCacheSchema.parse(draft), draft);
  assert.equal(templateDraftSchema.safeParse(draft).success, false);
  assert.equal(
    templateEditCacheSchema.safeParse({
      ...draft,
      payload: { ...draft.payload, unknownSecret: "x" },
    }).success,
    false,
  );
});
