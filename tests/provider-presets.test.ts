import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { agentConnectionSchema } from "../src/shared/agent-connections.js";
import {
  providerDraft,
  providerPresets,
} from "../src/ui/features/connections/provider-presets.js";

await test("provider drafts require model input, allocate unique names and choose matching authentication", () => {
  for (const preset of [...providerPresets, null]) {
    const draft = providerDraft(preset, []);
    assert.equal(
      agentConnectionSchema.safeParse(draft).success,
      false,
      "model must be entered before saving",
    );
    const entry = agentConnectionSchema.parse({
      ...draft,
      model: "fixture",
      ...(preset ? {} : { baseUrl: "https://example.com/v1" }),
    });
    assert.equal(providerDraft(preset, [entry]).id, `${entry.id}-2`);
    assert.equal(entry.auth, preset?.id === "local" ? "none" : "environment");
    assert.equal(entry.apiKeyEnv, preset?.env ?? "CUSTOM_API_KEY");
    if (preset?.id === "local") assert.equal(entry.api, "openai-completions");
  }
});

await test("native provider presets and their model examples exist in the pinned Pi SDK", () => {
  const providers = getBuiltinProviders();
  for (const preset of providerPresets.filter((entry) => !entry.api)) {
    const provider = providers.find((id) => id === preset.id);
    assert.ok(provider, preset.id);
    if (preset.id !== "openrouter")
      assert.ok(
        getBuiltinModels(provider).some(
          (model) => model.id === preset.modelHint,
        ),
        `${preset.id}/${preset.modelHint}`,
      );
  }
});
