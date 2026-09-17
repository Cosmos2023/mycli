import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const SOURCE_URL = new URL("../../src/pi-ai/pi-ai-model.ts", import.meta.url).href;
const DIRECTORY_SOURCE_URL = new URL("../../src/registry/provider-directory.ts", import.meta.url).href;
const REGISTRY_SOURCE_URL = new URL("../../src/registry/provider-registry.ts", import.meta.url).href;
const PROVIDER_MODULE_PATTERN = /\/node_modules\/@earendil-works\/pi-ai\/dist\/providers\/([^/]+)\.js/u;

test("complete provider directory remains lazy until directory demand", async () => {
	const imported = await loadedPiAiModules(
		`await import(${JSON.stringify(DIRECTORY_SOURCE_URL)});`,
	);
	assert.deepEqual(providerModules(imported.loaded), []);

	const selected = await loadedPiAiModules(`
		const { loadPiAiProviderDirectory } = await import(${JSON.stringify(DIRECTORY_SOURCE_URL)});
		const first = loadPiAiProviderDirectory();
		const second = loadPiAiProviderDirectory();
		const snapshot = await first;
		console.log(JSON.stringify({ cached: first === second, count: snapshot.providers.length }));
	`);
	assert.deepEqual(JSON.parse(selected.stdout), { cached: true, count: 40 });
	const loadedProviders = providerModules(selected.loaded);
	assert(loadedProviders.includes("all"));
	assert(loadedProviders.includes("radius"));
});

test("snapshot selection loads only the selected catalog provider", async () => {
	const imported = await loadedPiAiModules(`await import(${JSON.stringify(SOURCE_URL)});`);
	assert.deepEqual(providerModules(imported.loaded), ["faux"]);

	const selected = await loadedPiAiModules(`
		const { createPiAiSnapshot } = await import(${JSON.stringify(SOURCE_URL)});
		const snapshot = await createPiAiSnapshot({
			provider: "nvidia",
			protocol: "chat_completions",
			model: "openai/gpt-oss-120b",
			apiBaseUrl: "https://custom.example/v1",
			apiKey: "test-key",
			supportsImages: false,
		});
		console.log(JSON.stringify(snapshot.model.headers));
	`);

	assert.deepEqual(JSON.parse(selected.stdout), { "NVCF-POLL-SECONDS": "3600" });
	const loadedProviders = providerModules(selected.loaded);
	assert.deepEqual(loadedProviders, ["faux", "nvidia", "nvidia.models"]);
	assert(!selected.loaded.some((url) => /\/auth\/oauth\/(?!load\.js)/u.test(url)));
});

test("pi-ai-declared registry routes skip builtin provider lookup", async () => {
	const selected = await loadedPiAiModules(`
		const { ProviderRegistry } = await import(${JSON.stringify(REGISTRY_SOURCE_URL)});
		const frames = [
			'data: {"id":"chatcmpl_mock","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\\n\\n',
			'data: {"id":"chatcmpl_mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\\n\\n',
			'data: [DONE]\\n\\n',
		];
		const route = {
			routeId: "nvidia",
			displayName: "NVIDIA",
			supportTier: "stable",
			source: "pi_ai_declared",
			protocol: "chat_completions",
			apiBaseUrl: "https://declared.example/v1",
			authRef: "nvidia",
			activation: "active",
			modelPolicy: { kind: "declared", modelIds: ["openai/gpt-oss-120b"] },
			snapshotVersion: 1,
		};
		const config = {
			provider: "nvidia",
			protocol: "chat_completions",
			model: "openai/gpt-oss-120b",
			apiBaseUrl: "https://declared.example/v1",
			apiKey: "test-key",
			supportsImages: false,
		};
		const provider = new ProviderRegistry({
			fetch: async () => new Response(frames.join(""), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		}).create(config, route);
		const events = [];
		for await (const event of provider.stream({
			provider: config.provider,
			protocol: config.protocol,
			model: config.model,
			instructions: "system",
			messages: [{ role: "user", content: "hello" }],
			tools: [],
		}, { signal: new AbortController().signal })) events.push(event.type);
		console.log(JSON.stringify(events));
	`);

	assert.deepEqual(JSON.parse(selected.stdout), [
		"text_delta",
		"provider_state",
		"usage",
		"completed",
	]);
	assert.deepEqual(providerModules(selected.loaded), ["faux"]);
});

async function loadedPiAiModules(script: string): Promise<{
	readonly stdout: string;
	readonly loaded: readonly string[];
}> {
	const hook = dataUrl(`
		export async function load(url, context, nextLoad) {
			if (url.includes("/node_modules/@earendil-works/pi-ai/")) {
				process.stderr.write("MYCLI_LOADED " + url + "\\n");
			}
			return nextLoad(url, context);
		}
	`);
	const register = dataUrl(`
		import { register } from "node:module";
		register(${JSON.stringify(hook)}, import.meta.url);
	`);
	const result = await execFileAsync(process.execPath, [
		"--import",
		register,
		"--import",
		"tsx",
		"--input-type=module",
		"--eval",
		script,
	], {
		cwd: new URL("../..", import.meta.url),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});
	return Object.freeze({
		stdout: result.stdout.trim(),
		loaded: Object.freeze(result.stderr
			.split("\n")
			.filter((line) => line.startsWith("MYCLI_LOADED "))
			.map((line) => line.slice("MYCLI_LOADED ".length))),
	});
}

function providerModules(urls: readonly string[]): readonly string[] {
	return urls.flatMap((url) => {
		const match = PROVIDER_MODULE_PATTERN.exec(url);
		return match?.[1] ? [match[1]] : [];
	}).sort();
}

function dataUrl(source: string): string {
	return `data:text/javascript,${encodeURIComponent(source)}`;
}
