import assert from "node:assert/strict";
import test from "node:test";
import { cerebrasProvider } from "@earendil-works/pi-ai/providers/cerebras";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { nvidiaProvider } from "@earendil-works/pi-ai/providers/nvidia";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { togetherProvider } from "@earendil-works/pi-ai/providers/together";
import { BUILTIN_MODEL_CATALOG } from "@mycli/config";

test("curated defaults exist in pinned pi-ai OpenAI Completions catalogs", () => {
	const providers = {
		openrouter: openrouterProvider(),
		groq: groqProvider(),
		together: togetherProvider(),
		moonshotai: moonshotaiProvider(),
		nvidia: nvidiaProvider(),
		cerebras: cerebrasProvider(),
	} as const;

	for (const [providerId, provider] of Object.entries(providers)) {
		const entry = BUILTIN_MODEL_CATALOG.find((candidate) => (
			candidate.provider === providerId && candidate.isDefault
		));
		assert.ok(entry, `missing mycli default for ${providerId}`);
		assert.equal(provider.id, providerId);
		assert.equal(provider.baseUrl, entry.baseUrl);
		const model = provider.getModels().find((candidate) => candidate.id === entry.model);
		assert.ok(model, `pi-ai is missing ${providerId}/${entry.model}`);
		assert.equal(model.provider, providerId);
		assert.equal(model.api, "openai-completions");
	}
});
