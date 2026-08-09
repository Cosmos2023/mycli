import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	NODE_RUNTIME_CONTEXT_DEFAULTS,
	type NodeRuntimeConfig,
} from "@mycli/config";
import type {
	CanonicalToolCall,
	HookRunnerContract,
	InstructionSnapshot,
	ModelInputReference,
	ProviderEvent,
	ProviderRequest,
	ProviderRequestManifest,
	ToolDefinition,
	ToolSetSnapshot,
} from "@mycli/core";
import { manifestLogicalInputSha256, modelInputSha256 } from "@mycli/core";
import type { ModelProvider } from "@mycli/providers";
import { SQLiteSessionStore } from "@mycli/storage";
import type {
	ToolExecutionResult,
	ToolRouterContract,
} from "@mycli/tools";
import {
	commitRuntimeProviderStep,
	ContextItemCoordinator,
	NodeTurnRuntime,
	type NodeTurnRuntimeOptions,
} from "../src/index.ts";

const READ_TOOL: ToolDefinition = Object.freeze({
	id: "Read",
	name: "Read",
	description: "Read a file.",
	inputSchema: Object.freeze({
		type: "object",
		properties: Object.freeze({ file_path: Object.freeze({ type: "string" }) }),
		required: Object.freeze(["file_path"]),
		additionalProperties: false,
	}),
});

test("commits and reconstructs the exact logical request before provider dispatch", async (t) => {
	const fixture = await runtimeFixture(t);
	let providerCalls = 0;
	const provider: ModelProvider = {
		stream: async function* (request) {
			providerCalls += 1;
			const manifest = fixture.store.modelInputLedger.loadLatestProviderRequestManifest("session-1");
			assert.ok(manifest);
			assert.deepEqual(
				fixture.store.modelInputLedger.reconstructProviderStep(manifest.requestId).request,
				request,
			);
			assert.deepEqual(
				fixture.store.modelInputLedger.loadProviderStepEvents(manifest.requestId).map((event) => (
					event.state
				)),
				["prepared", "dispatch_started"],
			);
			yield { type: "text_delta", text: "done" } as const;
			yield { type: "completed", responseId: "response-1" } as const;
		},
	};
	const runtime = createDurableRuntime(fixture.store, provider, fixture.clock);

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(providerCalls, 1);
	const manifest = fixture.store.modelInputLedger.loadLatestProviderRequestManifest("session-1");
	assert.ok(manifest);
	assert.deepEqual(
		fixture.store.modelInputLedger.loadProviderStepEvents(manifest.requestId).map((event) => (
			event.state
		)),
		["prepared", "dispatch_started", "acknowledged"],
	);
});

test("fails closed without calling the provider when model-input persistence fails", async (t) => {
	const fixture = await runtimeFixture(t, "after_request_manifest");
	let providerCalls = 0;
	const runtime = createDurableRuntime(fixture.store, {
		stream: async function* () {
			providerCalls += 1;
			yield { type: "completed", responseId: "must-not-run" } as const;
		},
	}, fixture.clock);

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "persistence_error");
	assert.equal(providerCalls, 0);
	assert.equal(fixture.store.modelInputLedger.requiresBootstrap("session-1"), true);
});

test("persists accumulated user, pre-tool, and post-tool hook contexts on later steps", async (t) => {
	const fixture = await runtimeFixture(t);
	const requests: ProviderRequest[] = [];
	const scripts: readonly (readonly ProviderEvent[])[] = [
		[
			{
				type: "tool_call",
				callId: "call-1",
				name: "Read",
				argumentsJson: JSON.stringify({ file_path: "README.md" }),
			},
			{ type: "completed", responseId: "response-tools" },
		],
		[
			{ type: "text_delta", text: "done" },
			{ type: "completed", responseId: "response-final" },
		],
	];
	let scriptIndex = 0;
	const provider: ModelProvider = {
		stream: async function* (request) {
			requests.push(request);
			for (const event of scripts[scriptIndex++] ?? []) yield event;
		},
	};
	const hookRunner: HookRunnerContract = {
		run: async (input) => Object.freeze([Object.freeze({
			hookId: `hook:${input.point}`,
			result: Object.freeze({
				action: "allow" as const,
				additionalContexts: Object.freeze([
				input.point === "user_prompt_submit"
					? "prompt hook context"
					: input.point === "pre_tool_use"
						? "pre-tool hook context"
						: input.point === "post_tool_use"
							? "post-tool hook context"
							: "",
				].filter(Boolean)),
			}),
		})]),
	};
	const runtime = createDurableRuntime(fixture.store, provider, fixture.clock, {
		tools: [READ_TOOL],
		toolRouter: new ReadRouter(),
		hookRunner,
	});

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(requests.length, 2);
	assert.match(JSON.stringify(requests[0]?.items), /prompt hook context/u);
	const secondItems = JSON.stringify(requests[1]?.items);
	assert.match(secondItems, /prompt hook context/u);
	assert.match(secondItems, /pre-tool hook context/u);
	assert.match(secondItems, /post-tool hook context/u);
	const secondTexts = requests[1]?.items?.map((item) => "text" in item ? item.text : "") ?? [];
	const currentIndex = secondTexts.indexOf("Inspect the repository.");
	assert.ok(currentIndex > secondTexts.findIndex((text) => text.includes("prompt hook context")));
	assert.ok(currentIndex < secondTexts.findIndex((text) => text.includes("pre-tool hook context")));
	assert.ok(currentIndex < secondTexts.findIndex((text) => text.includes("post-tool hook context")));
	const manifest = fixture.store.modelInputLedger.loadLatestProviderRequestManifest("session-1");
	assert.ok(manifest);
	assert.equal(manifest.boundary, undefined);
	assert.deepEqual(
		fixture.store.modelInputLedger.reconstructProviderStep(manifest.requestId).request,
		requests[1],
	);
	const hooks = fixture.store.modelInputLedger.loadModelContextEvents("session-1").filter((event) => (
		event.fragment?.kind === "hook_context" && !event.tombstone
	));
	assert.equal(hooks.length, 3);
});

test("commits a DeepSeek tool batch before appending activated skill context", async (t) => {
	const fixture = await runtimeFixture(t);
	const requests: ProviderRequest[] = [];
	const skillText = [
		'<loaded-skill name="repository-analysis" source="builtin">',
		"Inspect the repository before answering.",
		"</loaded-skill>",
	].join("\n");
	const artifact = Object.freeze({
		kind: "skill_instructions" as const,
		name: "repository-analysis",
		text: skillText,
		sourceKind: "builtin",
		contentSha256: modelInputSha256(skillText),
		contentLength: skillText.length,
	});
	const calls = Object.freeze([
		Object.freeze({
			type: "tool_call" as const,
			callId: "call-skill",
			name: "Skill",
			argumentsJson: JSON.stringify({ name: "repository-analysis" }),
		}),
		Object.freeze({
			type: "tool_call" as const,
			callId: "call-status",
			name: "Shell",
			argumentsJson: JSON.stringify({ command: "git status --short" }),
		}),
		Object.freeze({
			type: "tool_call" as const,
			callId: "call-files",
			name: "Shell",
			argumentsJson: JSON.stringify({ command: "rg --files" }),
		}),
	]);
	let providerStep = 0;
	const provider: ModelProvider = {
		stream: async function* (request) {
			requests.push(request);
			providerStep += 1;
			if (providerStep === 1) {
				yield { type: "text_delta", text: "I will inspect the workspace first." } as const;
				for (const call of calls) yield call;
				yield { type: "completed", responseId: "deepseek-tools" } as const;
				return;
			}
			yield { type: "text_delta", text: "Workspace inspected." } as const;
			yield { type: "completed", responseId: "deepseek-final" } as const;
		},
	};
	const tools = [toolDefinition("Skill"), toolDefinition("Shell")];
	const runtime = createDurableRuntime(fixture.store, provider, fixture.clock, {
		config: {
			...runtimeConfig(),
			provider: "deepseek",
			protocol: "chat_completions",
			model: "deepseek-v4-flash",
		},
		tools,
		toolRouter: {
			execute: async (call) => Object.freeze({
				callId: call.callId,
				toolName: call.name,
				success: true,
				modelOutput: `${call.name} completed`,
				summary: `${call.name} completed`,
				metadata: call.name === "Skill" ? Object.freeze({ artifact }) : Object.freeze({}),
			}),
		},
		contextItemCoordinator: new ContextItemCoordinator({
			extractArtifact: (metadata) => metadata.artifact === artifact ? artifact : undefined,
		}),
	});

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(requests.length, 2);
	assert.deepEqual(requests[1]?.items?.slice(-5).map((item) => item.type), [
		"assistant_tool_calls",
		"tool_result",
		"tool_result",
		"tool_result",
		"context",
	]);
	assert.ok(requests[1]?.messages.some((message) => (
		message.role === "assistant" && message.content === "I will inspect the workspace first."
	)));
	const manifest = fixture.store.modelInputLedger.loadLatestProviderRequestManifest("session-1");
	assert.ok(manifest);
	assert.equal(manifest.providerStep, 2);
	assert.deepEqual(
		fixture.store.modelInputLedger.reconstructProviderStep(manifest.requestId).request,
		requests[1],
	);
});

test("keeps the prior logical input as an exact prefix across ordinary user turns", async (t) => {
	const fixture = await runtimeFixture(t);
	fixture.store.reserveTurn({
		sessionId: "session-1",
		clientTurnId: "client-turn-1",
		clientUserMessageId: "user-message-1",
		turnId: "turn-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: "/workspace",
		threadId: "session-1",
		userText: "U1",
		startedAt: fixture.clock(),
	});
	const content = "You are mycli.";
	const snapshot: InstructionSnapshot = Object.freeze({
		snapshotId: "instructions-prefix",
		version: "v1",
		source: "test",
		content,
		contentSha256: modelInputSha256(content),
		createdAt: fixture.clock(),
	});
	let id = 0;
	const shared = {
		sessionId: "session-1",
		requestConfig: runtimeRequestConfig(),
		instructionSnapshot: snapshot,
		tools: Object.freeze([]),
		sources: Object.freeze({
			environment: Object.freeze({ platform: "test", workspace_root: "/workspace" }),
		}),
		ledger: fixture.store.modelInputLedger,
		maxPromptTokens: 12_000,
		clock: fixture.clock,
		createId: (kind: "tools" | "context" | "request" | "lifecycle") => `${kind}-${++id}`,
	} as const;
	const first = commitRuntimeProviderStep({
		...shared,
		turnId: "turn-1",
		providerStep: 1,
		history: [{ type: "user", text: "U1" }],
		currentUserRequest: "U1",
	});
	const second = commitRuntimeProviderStep({
		...shared,
		turnId: "turn-2",
		providerStep: 2,
		history: [
			{ type: "user", text: "U1" },
			{ type: "assistant", text: "A1" },
			{ type: "user", text: "U2" },
		],
		currentUserRequest: "U2",
	});

	const firstItems = first.request.items ?? [];
	const secondItems = second.request.items ?? [];
	assert.deepEqual(secondItems.slice(0, firstItems.length), firstItems);
	assert.deepEqual(secondItems.slice(firstItems.length).map((item) => item.type), [
		"assistant",
		"user",
	]);
	assert.equal(second.requestSignature, first.requestSignature);
	assert.equal(second.manifest.boundary, undefined);
});

test("appends changed context before the next user without changing request compatibility", async (t) => {
	const fixture = await runtimeFixture(t);
	reserveModelInputSession(fixture.store, fixture.clock());
	const snapshot = instructionSnapshot("instructions-context-update", fixture.clock());
	let id = 0;
	const shared = {
		sessionId: "session-1",
		requestConfig: runtimeRequestConfig(),
		instructionSnapshot: snapshot,
		tools: Object.freeze([]),
		ledger: fixture.store.modelInputLedger,
		maxPromptTokens: 12_000,
		clock: fixture.clock,
		createId: (kind: "tools" | "context" | "request" | "lifecycle") => `${kind}-context-${++id}`,
	} as const;
	const first = commitRuntimeProviderStep({
		...shared,
		turnId: "turn-1",
		providerStep: 1,
		history: [{ type: "user", text: "U1" }],
		currentUserRequest: "U1",
		sources: Object.freeze({
			environment: Object.freeze({ platform: "test-v1", workspace_root: "/workspace" }),
		}),
	});
	const second = commitRuntimeProviderStep({
		...shared,
		turnId: "turn-2",
		providerStep: 2,
		history: [
			{ type: "user", text: "U1" },
			{ type: "assistant", text: "A1" },
			{ type: "user", text: "U2" },
		],
		currentUserRequest: "U2",
		sources: Object.freeze({
			environment: Object.freeze({ platform: "test-v2", workspace_root: "/workspace" }),
		}),
	});

	const firstItems = first.request.items ?? [];
	const secondItems = second.request.items ?? [];
	assert.deepEqual(secondItems.slice(0, firstItems.length), firstItems);
	assert.deepEqual(secondItems.slice(firstItems.length).map((item) => item.type), [
		"assistant",
		"context",
		"user",
	]);
	assert.match(JSON.stringify(secondItems.at(-2)), /test-v2/u);
	assert.equal(second.manifest.commonPrefixItemCount, firstItems.length);
	assert.equal(second.manifest.requestConfigurationSha256, first.manifest.requestConfigurationSha256);
	assert.equal(second.manifest.bootstrapPrefixSha256, first.manifest.bootstrapPrefixSha256);
	assert.notEqual(second.manifest.timelineSha256, first.manifest.timelineSha256);
	assert.equal(second.requestSignature, first.requestSignature);
	assert.equal(second.manifest.boundary, undefined);
});

test("reopens SQLite and extends the durable provider-input timeline", async (t) => {
	const fixture = await runtimeFixture(t);
	reserveModelInputSession(fixture.store, fixture.clock());
	const snapshot = instructionSnapshot("instructions-resume", fixture.clock());
	let firstId = 0;
	const first = commitRuntimeProviderStep({
		sessionId: "session-1",
		turnId: "turn-1",
		providerStep: 1,
		requestConfig: runtimeRequestConfig(),
		instructionSnapshot: snapshot,
		tools: Object.freeze([]),
		history: [{ type: "user", text: "U1" }],
		currentUserRequest: "U1",
		sources: Object.freeze({}),
		ledger: fixture.store.modelInputLedger,
		maxPromptTokens: 12_000,
		clock: fixture.clock,
		createId: (kind) => `${kind}-resume-first-${++firstId}`,
	});
	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixture.clock });
	t.after(() => reopened.close());
	let secondId = 0;
	const second = commitRuntimeProviderStep({
		sessionId: "session-1",
		turnId: "turn-2",
		providerStep: 2,
		requestConfig: runtimeRequestConfig(),
		instructionSnapshot: snapshot,
		tools: Object.freeze([]),
		history: [
			{ type: "user", text: "U1" },
			{ type: "assistant", text: "A1" },
			{ type: "user", text: "U2" },
		],
		currentUserRequest: "U2",
		sources: Object.freeze({}),
		ledger: reopened.modelInputLedger,
		maxPromptTokens: 12_000,
		clock: fixture.clock,
		createId: (kind) => `${kind}-resume-second-${++secondId}`,
	});

	const firstItems = first.request.items ?? [];
	assert.deepEqual(second.request.items?.slice(0, firstItems.length), firstItems);
	assert.equal(second.manifest.timelineWindowId, first.manifest.timelineWindowId);
	assert.equal(second.manifest.boundary, undefined);
	assert.deepEqual(
		reopened.modelInputLedger.reconstructProviderStep(second.manifest.requestId).request,
		second.request,
	);
});

test("adopts a durable v1 request through a legacy bootstrap window", async (t) => {
	const fixture = await runtimeFixture(t);
	reserveModelInputSession(fixture.store, fixture.clock());
	const snapshot = instructionSnapshot("instructions-legacy", fixture.clock());
	const tools: ToolSetSnapshot = Object.freeze({
		snapshotId: "tools-legacy",
		tools: Object.freeze([]),
		contentSha256: modelInputSha256([]),
		createdAt: fixture.clock(),
	});
	const orderedItems: readonly ModelInputReference[] = Object.freeze([
		Object.freeze({
			kind: "instruction_snapshot",
			id: snapshot.snapshotId,
			role: "system",
			contentSha256: snapshot.contentSha256,
		}),
		Object.freeze({
			kind: "tool_set_snapshot",
			id: tools.snapshotId,
			contentSha256: tools.contentSha256,
		}),
		Object.freeze({
			kind: "conversation_item",
			id: "turn-legacy:user",
			role: "user",
			contentSha256: modelInputSha256("U1"),
		}),
	]);
	const legacyRequest: ProviderRequest = Object.freeze({
		...runtimeRequestConfig(),
		instructions: snapshot.content,
		messages: Object.freeze([{ role: "user" as const, content: "U1" }]),
		items: Object.freeze([{ type: "user" as const, text: "U1" }]),
		tools: Object.freeze([]),
	});
	const legacyManifest: ProviderRequestManifest = Object.freeze({
		schemaVersion: 1,
		requestId: "request-legacy",
		sessionId: "session-1",
		turnId: "turn-legacy",
		providerStep: 0,
		providerConfig: runtimeRequestConfig(),
		instructionSnapshotId: snapshot.snapshotId,
		toolSetSnapshotId: tools.snapshotId,
		orderedItems,
		requestSignature: "sha256:legacy-request",
		logicalInputSha256: manifestLogicalInputSha256(snapshot, tools, orderedItems),
		contextPrefixSha256: modelInputSha256([]),
		boundary: "bootstrap",
		createdAt: fixture.clock(),
	});
	fixture.store.modelInputLedger.commitProviderStep({
		instructionSnapshot: snapshot,
		toolSetSnapshot: tools,
		contextEvents: Object.freeze([]),
		manifest: legacyManifest,
		request: legacyRequest,
		preparedEvent: Object.freeze({
			eventId: "lifecycle-legacy-prepared",
			requestId: legacyManifest.requestId,
			sessionId: "session-1",
			state: "prepared",
			payload: Object.freeze({}),
			createdAt: fixture.clock(),
		}),
	});
	let id = 0;
	const adopted = commitRuntimeProviderStep({
		sessionId: "session-1",
		turnId: "turn-2",
		providerStep: 1,
		requestConfig: runtimeRequestConfig(),
		instructionSnapshot: snapshot,
		tools: Object.freeze([]),
		history: [
			{ type: "user", text: "U1" },
			{ type: "assistant", text: "A1" },
			{ type: "user", text: "U2" },
		],
		currentUserRequest: "U2",
		sources: Object.freeze({}),
		ledger: fixture.store.modelInputLedger,
		maxPromptTokens: 12_000,
		clock: fixture.clock,
		createId: (kind) => `${kind}-legacy-${++id}`,
	});

	assert.equal(adopted.manifest.boundary, "legacy_bootstrap");
	assert.deepEqual(adopted.request.items?.slice(-3).map((item) => item.type), [
		"user",
		"assistant",
		"user",
	]);
	assert.equal(
		fixture.store.modelInputLedger.loadProviderInputTimelineEvents("session-1")[0]?.boundary,
		"legacy_bootstrap",
	);
	assert.deepEqual(
		fixture.store.modelInputLedger.reconstructProviderStep(legacyManifest.requestId).request,
		legacyRequest,
	);
});

test("identifies the first request using an appended compaction replacement boundary", async (t) => {
	const fixture = await runtimeFixture(t);
	fixture.store.reserveTurn({
		sessionId: "session-1",
		clientTurnId: "client-turn-1",
		clientUserMessageId: "user-message-1",
		turnId: "turn-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: "/workspace",
		threadId: "session-1",
		userText: "old request",
		startedAt: fixture.clock(),
	});
	const content = "You are mycli.";
	const snapshot: InstructionSnapshot = Object.freeze({
		snapshotId: "instructions-1",
		version: "v1",
		source: "test",
		content,
		contentSha256: modelInputSha256(content),
		createdAt: fixture.clock(),
	});
	let id = 0;
	const shared = {
		sessionId: "session-1",
		requestConfig: runtimeRequestConfig(),
		instructionSnapshot: snapshot,
		tools: Object.freeze([]),
		sources: Object.freeze({}),
		ledger: fixture.store.modelInputLedger,
		maxPromptTokens: 12_000,
		clock: fixture.clock,
		createId: (kind: "tools" | "context" | "request" | "lifecycle") => `${kind}-${++id}`,
	} as const;
	commitRuntimeProviderStep({
		...shared,
		turnId: "turn-1",
		providerStep: 1,
		history: [{ type: "user", text: "old request" }],
		currentUserRequest: "old request",
	});
	const compacted = commitRuntimeProviderStep({
		...shared,
		turnId: "turn-2",
		providerStep: 2,
		history: [
			{ type: "user", text: "[compact-summary]\nold work" },
			{ type: "user", text: "current request" },
		],
		currentUserRequest: "current request",
	});

	assert.equal(compacted.manifest.boundary, "compaction");
	assert.match(JSON.stringify(compacted.request.items), /\[compact-summary\]/u);
});

test("persists collaboration, permissions, skill catalog, workspace, and environment context", async (t) => {
	const fixture = await runtimeFixture(t);
	const requests: ProviderRequest[] = [];
	const policy = Object.freeze({
		mode: "danger-full-access" as const,
		filesystem: "unrestricted" as const,
		network: "enabled" as const,
		writableRoots: Object.freeze(["/workspace"]),
	});
	const executionPolicyCoordinator: NonNullable<
		NodeTurnRuntimeOptions["executionPolicyCoordinator"]
	> = {
		configure: () => undefined,
		snapshot: () => Object.freeze({ trusted: true, valid: true, profile: policy }),
		beginTurn: () => Object.freeze({ toolsEnabled: true, profile: policy }),
		finishTurn: () => undefined,
	};
	const runtime = createDurableRuntime(fixture.store, {
		stream: async function* (request) {
			requests.push(request);
			yield { type: "text_delta", text: "done" } as const;
			yield { type: "completed", responseId: "response-context" } as const;
		},
	}, fixture.clock, {
		executionPolicyCoordinator,
		contextSources: () => Object.freeze({
			skillCatalog: "Available skills:\n- review: Review changes",
			workspace: Object.freeze({
				content: "Use repository conventions.",
				diagnostics: Object.freeze({
					selectedSource: "agents",
					path: "/workspace/AGENTS.md",
					searchRoots: Object.freeze(["/workspace"]),
					truncated: false,
					originalLength: 27,
					renderedLength: 27,
					blocked: false,
					issues: Object.freeze([]),
				}),
			}),
			environment: Object.freeze({ platform: "test", workspace_root: "/workspace" }),
		}),
	});
	runtime.configureExecutionPolicy({ trust: "trusted", permission: "full-access" });
	runtime.configureRuntimeContext({ collaborationMode: "plan" });

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	const serialized = JSON.stringify(requests[0]);
	assert.match(serialized, /collaboration_mode/u);
	assert.match(serialized, /permission_profile: full-access/u);
	assert.match(serialized, /Available skills/u);
	assert.match(serialized, /Use repository conventions/u);
	assert.match(serialized, /workspace_root/u);
	const manifest = fixture.store.modelInputLedger.loadLatestProviderRequestManifest("session-1");
	assert.ok(manifest);
	assert.deepEqual(
		fixture.store.modelInputLedger.reconstructProviderStep(manifest.requestId).request,
		requests[0],
	);
});

function createDurableRuntime(
	store: SQLiteSessionStore,
	provider: ModelProvider,
	clock: () => string,
	options: {
		readonly config?: NodeRuntimeConfig;
		readonly tools?: readonly ToolDefinition[];
		readonly toolRouter?: ToolRouterContract;
		readonly hookRunner?: HookRunnerContract;
		readonly contextItemCoordinator?: NodeTurnRuntimeOptions["contextItemCoordinator"];
		readonly executionPolicyCoordinator?: NodeTurnRuntimeOptions["executionPolicyCoordinator"];
		readonly contextSources?: NodeTurnRuntimeOptions["contextSources"];
	} = {},
): NodeTurnRuntime {
	let id = 0;
	return new NodeTurnRuntime({
		sessionId: "session-1",
		workspaceRoot: "/workspace",
		threadId: "session-1",
		instructions: "You are mycli.",
		modelInputLedger: store.modelInputLedger,
		createModelInputId: (kind) => `${kind}-${++id}`,
		store,
		resolveConfig: () => options.config ?? runtimeConfig(),
		createProvider: () => provider,
		loadLocalImages: () => [],
		createTurnId: () => "turn-1",
		clock,
		publishLifecycle: () => undefined,
		planTools: () => options.tools ?? [],
		...(options.toolRouter ? { toolRouter: options.toolRouter } : {}),
		...(options.hookRunner ? { hookRunner: options.hookRunner } : {}),
		...(options.contextItemCoordinator ? {
			contextItemCoordinator: options.contextItemCoordinator,
		} : {}),
		...(options.executionPolicyCoordinator ? {
			executionPolicyCoordinator: options.executionPolicyCoordinator,
		} : {}),
		...(options.contextSources ? { contextSources: options.contextSources } : {}),
	});
}

class ReadRouter implements ToolRouterContract {
	execute(
		call: CanonicalToolCall,
	): Promise<ToolExecutionResult> {
		return Promise.resolve(Object.freeze({
			callId: call.callId,
			toolName: call.name,
			success: true,
			modelOutput: "README contents",
			summary: "Read README.md",
			metadata: Object.freeze({}),
		}));
	}
}

function toolDefinition(name: string): ToolDefinition {
	return Object.freeze({
		id: name,
		name,
		description: `${name} test tool.`,
		inputSchema: Object.freeze({
			type: "object",
			properties: Object.freeze({}),
			required: Object.freeze([]),
			additionalProperties: true,
		}),
	});
}

async function runtimeFixture(
	t: test.TestContext,
	failpoint?: "after_request_manifest",
): Promise<{
	readonly store: SQLiteSessionStore;
	readonly clock: () => string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-runtime-model-input-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	let tick = 0;
	const clock = (): string => new Date(Date.UTC(2026, 7, 8, 0, 0, tick++)).toISOString();
	const dbPath = join(root, "sessions.db");
	const store = new SQLiteSessionStore({
		dbPath,
		clock,
		...(failpoint ? {
			modelInputFailpoint: (name) => {
				if (name === failpoint) throw new Error("injected model-input failure");
			},
		} : {}),
	});
	t.after(() => store.close());
	return { store, clock, dbPath };
}

function instructionSnapshot(snapshotId: string, createdAt: string): InstructionSnapshot {
	const content = "You are mycli.";
	return Object.freeze({
		snapshotId,
		version: "v1",
		source: "test",
		content,
		contentSha256: modelInputSha256(content),
		createdAt,
	});
}

function reserveModelInputSession(store: SQLiteSessionStore, startedAt: string): void {
	store.reserveTurn({
		sessionId: "session-1",
		clientTurnId: "client-turn-model-input",
		clientUserMessageId: "user-message-model-input",
		turnId: "turn-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: "/workspace",
		threadId: "session-1",
		userText: "U1",
		startedAt,
	});
}

function submission() {
	return Object.freeze({
		clientTurnId: "client-turn-1",
		clientUserMessageId: "user-message-1",
		message: "Inspect the repository.",
	});
}

function runtimeConfig(): NodeRuntimeConfig {
	return Object.freeze({
		...NODE_RUNTIME_CONTEXT_DEFAULTS,
		workspaceRoot: "/workspace",
		homeDir: "/home/test",
		provider: "openai",
		protocol: "responses",
		model: "gpt-test",
		apiBaseUrl: "https://api.openai.com/v1",
		apiKey: "test-key",
		authRef: "openai",
		sessionId: "session-1",
		sessionsDbPath: "/home/test/.mycli/sessions.db",
		maxPromptTokens: 12_000,
		requestMaxRetries: 0,
		streamMaxRetries: 0,
		reasoningEffort: "none",
		thinkingEnabled: false,
		supportsImages: true,
		promptCacheKeyEnabled: false,
	});
}

function runtimeRequestConfig() {
	return Object.freeze({
		provider: "openai" as const,
		protocol: "responses" as const,
		model: "gpt-test",
		reasoningEffort: "none" as const,
	});
}
