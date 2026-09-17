import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalImage, ProtocolId, ProviderEvent, ProviderRequest } from "@mycli/core";
import { ProviderFailure } from "../../src/errors.ts";
import { PiAiProvider } from "../../src/pi-ai/pi-ai-provider.ts";
import { providerStreamFixture } from "../support/provider-stream-fixtures.ts";

const IMAGE: CanonicalImage = { mediaType: "image/png", data: "aW1hZ2U=" };

test("effective pi-ai catalog capability bounds optimistic configuration without provider IO", async () => {
	let requests = 0;
	const provider = new PiAiProvider({ config: {
		provider: "deepseek", model: "deepseek-v4-flash", protocol: "chat_completions",
		apiBaseUrl: "https://offline.invalid/v1", apiKey: "fixture", supportsImages: true,
	}, fetch: async () => { requests += 1; throw new Error("must not contact provider"); } });
	assert.equal((await provider.resolveCapabilities()).supportsImages, false);
	assert.equal(requests, 0);
});

for (const protocol of ["responses", "chat_completions", "anthropic_messages"] as const) {
	test(`${protocol} projects real tool images through the installed SDK`, async () => {
		let payload: unknown;
		const request = imageRequest(protocol);
		const provider = new PiAiProvider({
			config: { ...request, apiBaseUrl: "https://offline.invalid/v1", apiKey: "fixture", supportsImages: true },
			fetch: async (_input, init) => {
				payload = JSON.parse(init!.body as string) as unknown;
				return providerStreamFixture(protocol, "healthy");
			},
		});
		assert.equal((await collect(provider, request)).at(-1)?.type, "completed");
		const image = records(payload).find((value) => value.type === (protocol === "responses" ? "input_image" : protocol === "chat_completions" ? "image_url" : "image"));
		assert.ok(image, "provider wire payload must contain an image block");
		if (protocol === "anthropic_messages") assert.deepEqual(image.source, { type: "base64", media_type: "image/png", data: IMAGE.data });
		else if (protocol === "responses") assert.equal(image.image_url, `data:image/png;base64,${IMAGE.data}`);
		else assert.equal((image.image_url as { url: string }).url, `data:image/png;base64,${IMAGE.data}`);
		assert.ok(JSON.stringify(payload).includes("Image inspected"));
	});
}

test("invalid or unsupported tool images fail before provider IO", async () => {
	for (const supportsImages of [true, false]) {
		let fetches = 0;
		const request = imageRequest("responses", supportsImages ? { mediaType: "image/png", data: "invalid" } : IMAGE);
		const provider = new PiAiProvider({
			config: { ...request, apiBaseUrl: "https://offline.invalid/v1", apiKey: "fixture", supportsImages },
			fetch: async () => { fetches += 1; return providerStreamFixture("responses", "healthy"); },
		});
		await assert.rejects(collect(provider, request), (error: unknown) => error instanceof ProviderFailure && error.code === (supportsImages ? "provider_error" : "unsupported_capability"));
		assert.equal(fetches, 0);
	}
});

async function collect(provider: PiAiProvider, request: ProviderRequest): Promise<readonly ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of provider.stream(request, { signal: AbortSignal.timeout(5_000) })) events.push(event);
	return events;
}

function imageRequest(protocol: ProtocolId, image = IMAGE): ProviderRequest {
	return {
		provider: protocol === "anthropic_messages" ? "anthropic" : "openai", protocol, model: "image-test",
		instructions: "Inspect images", messages: [{ role: "user", content: "Inspect" }],
		tools: [{ id: "builtin:view_image", name: "view_image", description: "View", inputSchema: { type: "object", properties: {} } }],
		items: [
			{ type: "user", text: "Inspect" },
			{ type: "assistant_tool_calls", text: "", calls: [{ callId: "image-call", name: "view_image", argumentsJson: "{}" }] },
			{ type: "tool_result", callId: "image-call", toolName: "view_image", success: true, output: "Image inspected", images: [image] },
		],
	};
}

function records(value: unknown): Readonly<Record<string, unknown>>[] {
	if (Array.isArray(value)) return value.flatMap(records);
	if (typeof value !== "object" || value === null) return [];
	const record = value as Readonly<Record<string, unknown>>;
	return [record, ...Object.values(record).flatMap(records)];
}
