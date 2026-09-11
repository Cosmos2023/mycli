import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NODE_RUNTIME_CONTEXT_DEFAULTS, type NodeRuntimeConfig } from "@mycli/config";
import { readErrorContext } from "@mycli/contracts";
import type { ProviderEvent, ProviderRequest, RuntimeEvent, ToolDefinition } from "@mycli/core";
import type { ModelProvider, ProviderRouteDescriptor } from "@mycli/providers";
import { openRuntimeSessionStore, type RuntimeSessionStore } from "@mycli/storage";
import { ToolRouter, ViewImageTool, type ToolAdapter, type ToolExecutionOptions } from "@mycli/tools";
import { NodeTurnRuntime } from "../../src/index.ts";

const IMAGE = { mediaType: "image/png" as const, data: "aW1hZ2U=" };

for (const scenario of [
	{ name: "configured image opt-out overrides catalog support", configured: false, catalog: true },
	{ name: "missing catalog metadata preserves configured image support", configured: true, catalog: undefined },
	{ name: "missing catalog metadata preserves configured image opt-out", configured: false, catalog: undefined },
]) {
	test(scenario.name, async (t) => {
		const fixture = await databaseFixture(t);
		const requests: ProviderRequest[] = [];
		const executions: ToolExecutionOptions[] = [];
		const events: RuntimeEvent[] = [];
		const tool: ToolAdapter = {
			definition: new ViewImageTool({ workspaceRoot: fixture.root, homeDir: fixture.root }).definition,
			execute: async (_arguments, options) => {
				executions.push(options);
				return { success: true, modelOutput: "Image attached", summary: "Viewed image", images: [IMAGE], metadata: {} };
			},
		};
		const provider: ModelProvider = {
			...(scenario.catalog !== undefined ? { resolveCapabilities: async () => ({ supportsImages: scenario.catalog! }) } : {}),
			stream: async function* (request) {
				requests.push(request);
				if (requests.length === 1) yield { type: "tool_call", callId: "image-call", name: "view_image", argumentsJson: '{"path":"fixture.png"}' };
				else yield { type: "text_delta", text: "Done" };
				yield { type: "completed", responseId: `response-${requests.length}` };
			},
		};
		const result = await runtimeFor(fixture.store, fixture.root, [tool], provider, scenario.configured).submit(
			{ clientTurnId: "client:capability", message: "Inspect image" }, (event) => events.push(event), { signal: new AbortController().signal },
		);
		assert.equal(result.status, "completed");
		assert.equal(requests.length, 2);
		assert.ok(requests.every((request) => request.tools.some((definition) => definition.name === "view_image") === scenario.configured));
		assert.equal(executions.length, scenario.configured ? 1 : 0);
		const failed = events.filter((event) => event.type === "tool_execution_failed");
		assert.equal(failed.length, scenario.configured ? 0 : 1);
		if (scenario.configured) {
			assert.equal(executions[0]?.imageInputSupported, true);
			assert.equal(executions[0]?.imageDetailOriginalSupported, false);
			const imageResult = requests[1]?.items?.find((item) => item.type === "tool_result");
			assert.ok(imageResult?.type === "tool_result");
			assert.deepEqual(imageResult.images, [IMAGE]);
		} else {
			assert.equal(readErrorContext(failed[0]?.metadata.error_context)?.reason, "capability.image_input_unsupported");
		}
	});
}

test("known text-only capability hides view_image and rejects a stale call without ending the agent loop", async (t) => {
	const fixture = await databaseFixture(t);
	const tool = new ViewImageTool({ workspaceRoot: fixture.root, homeDir: fixture.root });
	const requests: ProviderRequest[] = [];
	const events: RuntimeEvent[] = [];
	const runtime = runtimeFor(fixture.store, fixture.root, [tool], {
		resolveCapabilities: async () => ({ supportsImages: false }),
		stream: async function* (request) {
			requests.push(request);
			if (requests.length === 1) yield { type: "tool_call", callId: "image-call", name: "view_image", argumentsJson: '{"path":"does-not-exist.png"}' };
			else yield { type: "text_delta", text: "The model cannot inspect images." };
			yield { type: "completed", responseId: `response-${requests.length}` };
		},
	});
	const turn = await runtime.submit({ clientTurnId: "client:stale", message: "Inspect an image" }, (event) => events.push(event), { signal: new AbortController().signal });
	assert.equal(turn.status, "completed");
	assert.equal(requests.length, 2);
	assert.ok(requests.every((request) => !request.tools.some((definition) => definition.name === "view_image")));
	const failed = events.filter((event) => event.type === "tool_execution_failed");
	assert.equal(failed.length, 1);
	assert.equal(readErrorContext(failed[0]?.metadata.error_context)?.reason, "capability.image_input_unsupported");
	assert.deepEqual(readErrorContext(failed[0]?.metadata.error_context)?.outcome, { state: "not_started", effects: "none" });
	assert.equal(fixture.store.loadConversationItems("session:image").filter((item) => item.type === "tool_result").length, 1);
});

test("dynamic tool images remain committed across incompatible-model restart and explicit compatible selection", async (t) => {
	const fixture = await databaseFixture(t);
	let executions = 0;
	let requests = 0;
	const definition: ToolDefinition = { id: "mcp:fixture:image", name: "mcp_fixture_image", description: "Fixture image", inputSchema: { type: "object", properties: {} } };
	const tool: ToolAdapter = { definition, execute: async () => {
		executions += 1;
		return { success: true, modelOutput: "Image attached", summary: "Image attached", images: [IMAGE], metadata: {} };
	} };
	const incompatible: ModelProvider = {
		resolveCapabilities: async () => ({ supportsImages: false }),
		stream: async function* (): AsyncIterable<ProviderEvent> {
			requests += 1;
			yield { type: "tool_call", callId: "dynamic-image", name: definition.name, argumentsJson: "{}" };
			yield { type: "completed", responseId: "response:image" };
		},
	};
	const first = await runtimeFor(fixture.store, fixture.root, [tool], incompatible).submit(
		{ clientTurnId: "client:dynamic", message: "Inspect the dynamic image" }, () => {}, { signal: new AbortController().signal },
	);
	assert.equal(first.error_code, "unsupported_capability");
	const failure = readErrorContext(first.result?.error_context);
	assert.equal(failure?.reason, "capability.image_input_unsupported");
	assert.equal(failure?.details && "input_origin" in failure.details ? failure.details.input_origin : undefined, "tool");
	assert.equal(executions, 1);
	assert.equal(requests, 1);
	fixture.store.close();
	const store = openRuntimeSessionStore({ dbPath: fixture.dbPath });
	t.after(() => store.close());
	const resumed = await runtimeFor(store, fixture.root, [tool], incompatible).submit(
		{ clientTurnId: "client:resumed", message: "Continue" }, () => {}, { signal: new AbortController().signal },
	);
	assert.equal(resumed.error_code, "unsupported_capability");
	assert.equal(requests, 1, "incompatible history must not reach provider IO");
	let compatibleRequest: ProviderRequest | undefined;
	const compatible: ModelProvider = {
		resolveCapabilities: async () => ({ supportsImages: true }),
		stream: async function* (request) {
			requests += 1;
			compatibleRequest = request;
			yield { type: "text_delta", text: "Image inspected" };
			yield { type: "completed", responseId: "response:compatible" };
		},
	};
	const completed = await runtimeFor(store, fixture.root, [tool], compatible).submit(
		{ clientTurnId: "client:compatible", message: "Inspect using the compatible model" }, () => {}, { signal: new AbortController().signal },
	);
	assert.equal(completed.status, "completed", JSON.stringify(completed));
	const imageResult = compatibleRequest?.items?.find((item) => item.type === "tool_result" && item.callId === "dynamic-image");
	assert.ok(imageResult?.type === "tool_result");
	assert.deepEqual(imageResult.images, [IMAGE]);
	assert.equal(executions, 1, "a completed external effect must not be repeated after model correction");
	assert.equal(store.loadConversationItems("session:image").filter((item) => item.type === "tool_result" && item.callId === "dynamic-image").length, 1);
});

function runtimeFor(store: RuntimeSessionStore, root: string, adapters: readonly ToolAdapter[], provider: ModelProvider, supportsImages = true): NodeTurnRuntime {
	const config: NodeRuntimeConfig = { ...NODE_RUNTIME_CONTEXT_DEFAULTS, workspaceRoot: root, homeDir: root,
		provider: "openai", protocol: "responses", model: "fixture-image-model", apiBaseUrl: "https://offline.invalid/v1",
		apiKey: "fixture", authRef: "openai", sessionId: "session:image", sessionsDbPath: join(root, "session.db"),
		maxPromptTokens: 12_000, requestMaxRetries: 1, streamMaxRetries: 1, reasoningEffort: "none", thinkingEnabled: false,
		supportsImages, webSearchMode: "disabled", requestPermissionsToolEnabled: false, updatesCheckOnStartup: false,
	};
	const route: ProviderRouteDescriptor = {
		routeId: config.provider, displayName: "Fixture", supportTier: "compatible", source: "pi_ai_declared",
		protocol: config.protocol, apiBaseUrl: config.apiBaseUrl, authRef: config.authRef,
		activation: "active", modelPolicy: { kind: "declared", modelIds: [config.model] }, snapshotVersion: 1,
	};
	return new NodeTurnRuntime({ sessionId: config.sessionId, workspaceRoot: root, threadId: config.sessionId,
		instructions: "Fixture", store, resolveConfig: () => config, createProvider: () => provider,
		resolveProviderRoute: (resolved) => {
			assert.equal(resolved, config, "provider route lookup must retain the captured configuration identity");
			return route;
		},
		modelInputLedger: store.modelInputLedger, agentEffectLedger: store.agentEffectLedger, providerAttemptLedger: store.providerAttemptLedger,
		planTools: () => adapters.map((adapter) => adapter.definition),
		toolRouter: new ToolRouter({ adapters, exposure: adapters.map((adapter) => adapter.definition) }),
		isMutatingTool: (name) => name !== "view_image", loadLocalImages: () => [],
		createTurnId: () => randomUUID(), clock: () => new Date().toISOString(), publishLifecycle: () => {},
	});
}

async function databaseFixture(t: test.TestContext): Promise<{ root: string; dbPath: string; store: RuntimeSessionStore }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-image-capability-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "session.db");
	const store = openRuntimeSessionStore({ dbPath });
	t.after(() => store.close());
	return { root, dbPath, store };
}
