import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import { ChatProvider, ResponsesProvider } from "../src/index.ts";

test("maps the shared sanitized provider event corpus", async () => {
	const fixture = JSON.parse(await readFile(
		new URL("../../../../tests/fixtures/node_runtime_m2/provider_events.json", import.meta.url),
		"utf8",
	)) as { cases: Array<{
		name: string;
		protocol: "responses" | "chat_completions";
		raw: unknown[];
		expected: ProviderEvent[];
	}> };
	for (const scenario of fixture.cases) {
		const provider = scenario.protocol === "responses"
			? new ResponsesProvider({ client: { create: async () => events(scenario.raw) } })
			: new ChatProvider({ client: { create: async () => events(scenario.raw) } });
		assert.deepEqual(await collect(provider.stream(request(scenario.protocol), {
			signal: new AbortController().signal,
		})), scenario.expected, scenario.name);
	}
});

function request(protocol: "responses" | "chat_completions"): ProviderRequest {
	return {
		provider: "openai",
		protocol,
		model: "fixture",
		instructions: "",
		messages: [{ role: "user", content: "fixture" }],
		tools: [],
	};
}

async function* events(items: readonly unknown[]): AsyncIterable<unknown> {
	for (const item of items) yield item;
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const result: ProviderEvent[] = [];
	for await (const event of stream) result.push(event);
	return result;
}
