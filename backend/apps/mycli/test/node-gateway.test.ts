import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import test from "node:test";
import { parseGatewayEvent, parseJsonRpcMessage } from "@mycli/contracts";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import {
	fingerprintSubmission,
	type QueueSnapshot,
	type RuntimeEvent,
	type ShellLifecycleEvent,
} from "@mycli/core";
import {
	QueueCoordinator,
	SessionCoordinator,
	type PendingApprovalChoice,
	type PreparedSession,
	type QueueCoordinatorStore,
	type TurnSubmission,
} from "@mycli/runtime";
import { StorageFailure } from "@mycli/storage";
import type {
	LoadShellOutputPageInput,
	SessionOverview,
	ShellOutputPage,
	TranscriptItem,
} from "@mycli/storage";
import type { ShellSessionSnapshot } from "@mycli/tools";
import {
	createNodeGateway,
	type NodeGatewayRuntime,
} from "../src/node-runtime/node-gateway.ts";
import type {
	AgentInteractiveNotification,
	AgentInteractiveRequestGateway,
} from "../src/node-runtime/agent-interactive-requests.ts";

type RpcMessage = ReturnType<typeof parseJsonRpcMessage>;

const TUI_BUILTIN_COMMAND_NAMES = [
	"/model",
	"/plan",
	"/permissions",
	"/new",
	"/resume",
	"/fork",
	"/status",
	"/usage",
	"/compact",
	"/skills",
	"/tools",
	"/agents",
	"/ps",
	"/changes",
	"/help",
	"/quit",
] as const;

function permissionPayload(active: "read-only" | "workspace" | "full-access") {
	return {
		active,
		command_allowance_count: 0,
		profiles: [
			{
				id: "workspace",
				label: "Ask for approval",
				description: "Read and edit the current workspace; ask before network or outside access.",
				current: active === "workspace",
			},
			{
				id: "full-access",
				label: "Full Access",
				description: "Access files and network without approval.",
				current: active === "full-access",
			},
			{
				id: "read-only",
				label: "Read Only",
				description: "Read workspace files; ask before edits or network.",
				current: active === "read-only",
			},
		],
	};
}

function gatewayHarness(options: {
	conversation?: readonly { role: "user" | "assistant"; content: string }[];
	existingTurn?: RuntimeTurnRecord;
	reserve?: (submission: TurnSubmission) => {
		readonly kind: "reserved" | "existing";
		readonly turn: RuntimeTurnRecord;
	};
	sessions?: {
		readonly targetFailure?: string;
		readonly targetReadOnly?: boolean;
		readonly prepareTarget?: () => Promise<void>;
		readonly targetQueue?: QueueSnapshot;
		readonly initialPendingApproval?: boolean;
		readonly targetPendingApproval?: boolean;
		readonly initialPendingClarification?: boolean;
		readonly targetPendingClarification?: boolean;
		readonly approvalOptions?: readonly PendingApprovalChoice[];
	};
	queue?: {
		readonly initial?: QueueSnapshot;
	};
	approvalFailure?: Error;
	clarificationFailure?: Error;
	shell?: boolean;
	workspaceTrust?: boolean;
	integrations?: boolean;
	integrationCommands?: readonly Record<string, unknown>[];
	memory?: boolean;
	backgroundTasks?: boolean;
	control?: boolean;
	maxPromptTokens?: number;
	turnRollouts?: readonly Readonly<Record<string, unknown>>[];
	agentInteractiveRequests?: AgentInteractiveRequestGateway;
	cooperativeInterrupt?: boolean;
	loadShellOutput?: (input: LoadShellOutputPageInput) => ShellOutputPage;
} = {}) {
	let emitRuntime: ((event: RuntimeEvent) => void) | null = null;
	let signal: AbortSignal | null = null;
	let closeCalls = 0;
	let runtimeSettled = false;
	let forcedInterrupts = 0;
	let releaseTurn!: () => void;
	const turnReleased = new Promise<void>((resolve) => { releaseTurn = resolve; });
	const waitForTurnRelease = async (activeSignal: AbortSignal): Promise<void> => {
		if (!options.cooperativeInterrupt) {
			await turnReleased;
			return;
		}
		if (activeSignal.aborted) return;
		let removeAbort = (): void => undefined;
		try {
			await Promise.race([
				turnReleased,
				new Promise<void>((resolve) => {
					const onAbort = (): void => { resolve(); };
					activeSignal.addEventListener("abort", onAbort, { once: true });
					removeAbort = () => activeSignal.removeEventListener("abort", onAbort);
				}),
			]);
		} finally {
			removeAbort();
		}
	};
	const submissions: TurnSubmission[] = [];
	const approvalResolutions: Array<{
		readonly decisionId: string;
		readonly choice: PendingApprovalChoice;
	}> = [];
	const clarificationResolutions: Array<{
		readonly requestId: string;
		readonly response: string;
	}> = [];
	const reservedClientTurnIds: string[] = [];
	const policyConfigurations: Array<{
		readonly trust: "trusted" | "untrusted" | "unknown";
		readonly permission: "read-only" | "workspace" | "full-access";
	}> = [];
	const runtimeContexts: Array<{ readonly collaborationMode: string }> = [];
	let commandAllowances: string[][] = [];
	const taskInterruptions: string[] = [];
	const traceAppends: Array<{ sessionId: string; event: Record<string, unknown> }> = [];
	const sessionCommandCalls: Array<Readonly<Record<string, unknown>>> = [];
	const savedApiKeys: Array<Readonly<{ providerId: string; apiKey: string }>> = [];
	const selectedModels: Array<Readonly<Record<string, unknown>>> = [];
	let visualSettings: Readonly<Record<string, unknown>> = {
		statusbar_mode: "full",
		view_mode: "default",
	};
	const queue = options.queue
		? gatewayQueueFixture(options.queue.initial ?? emptyQueue("session-node"))
		: undefined;
	const shell = options.shell ? gatewayShellFixture() : undefined;
	const subagentListeners = new Set<(subagent: Readonly<Record<string, unknown>>) => void>();
	const extensionListeners = new Set<(version: number) => void>();
	const memories: Record<string, unknown>[] = [{
		filename: "architecture.md",
		name: "Architecture",
		kind: "user",
		description: "Layering decisions",
		content: "Keep clear boundaries",
	}];
	const integrations = options.integrations ? {
		toolManifest: {
			schema_version: 1,
			source: "combined",
			toolsets: [{ id: "external", tool_count: 2 }, { id: "file", tool_count: 1 }],
			tools: [
				{ id: "builtin:Read", name: "Read", source: "builtin", toolset: "file" },
				{ id: "skill:Skill", name: "Skill", source: "skill", toolset: "external" },
				{ id: "mcp:docs:search", name: "McpSearch", source: "mcp", toolset: "external" },
			],
		},
		listResources: () => [{
			id: "skill:review",
			type: "skill",
			name: "review",
			source: "repo",
			enabled: true,
			status: "enabled",
			detail: "Review changes",
			command: "/tools skills",
		}, {
			id: "mcp:docs:file:///README.md",
			type: "plugin",
			name: "docs README",
			source: "runtime",
			enabled: true,
			status: "enabled",
			detail: "MCP resource file:///README.md",
			command: "/mcp inspect docs",
		}],
		commands: {
			list: () => options.integrationCommands ?? [{
				id: "plugin:demo:status",
				name: "/plugin:demo:status",
				description: "Show demo plugin status",
				argument_policy: "json",
				available_during_turn: true,
			}],
			run: async (command: string) => command.split(/\s+/u, 1)[0] === "/plugin:demo:status"
				? {
					result_id: "command:plugin-demo-status",
					presentation: "transcript",
					command_kind: "plugin",
					lines: ["demo ready"],
				}
				: undefined,
		},
			subscribeSubagents: (listener: (subagent: Readonly<Record<string, unknown>>) => void) => {
				subagentListeners.add(listener);
				return () => { subagentListeners.delete(listener); };
			},
			subscribeExtensions: (listener: (version: number) => void) => {
				extensionListeners.add(listener);
				return () => { extensionListeners.delete(listener); };
			},
		} : undefined;
	const reserve = options.reserve ?? ((submission: TurnSubmission) => {
		const fingerprint = fingerprintSubmission({
			message: submission.message,
			localImages: submission.localImages,
		});
		if (options.existingTurn) {
			if (options.existingTurn.request_fingerprint !== fingerprint) {
				throw Object.assign(new Error("conflicting payload"), { code: "message_id_conflict" });
			}
			return { kind: "existing" as const, turn: options.existingTurn };
		}
		return {
			kind: "reserved" as const,
			turn: turnRecord(submission, "in_progress"),
		};
	});
	const runtime = {
		...(queue ? { queueCoordinator: queue.coordinator } : {}),
		reserve: (submission: TurnSubmission) => {
			reservedClientTurnIds.push(submission.clientTurnId);
			return reserve(submission);
		},
		configureExecutionPolicy: (input: typeof policyConfigurations[number]) => {
			policyConfigurations.push(input);
		},
		configureRuntimeContext: (input: typeof runtimeContexts[number]) => {
			runtimeContexts.push(input);
		},
		listCommandAllowances: () => commandAllowances.map((pattern) => [...pattern]),
		addCommandAllowance: (pattern: string) => {
			commandAllowances = [...commandAllowances, pattern.split(/\s+/u)];
			return commandAllowances.map((item) => [...item]);
		},
		removeCommandAllowance: (pattern: string) => {
			commandAllowances = commandAllowances.filter((item) => item.join(" ") !== pattern);
			return commandAllowances.map((item) => [...item]);
		},
		clearCommandAllowances: () => {
			const count = commandAllowances.length;
			commandAllowances = [];
			return count;
		},
		compact: async () => ({ status: "compressed" as const, beforeTokens: 900, afterTokens: 300 }),
		resolveApproval: async (
			input: { readonly decisionId: string; readonly choice: PendingApprovalChoice },
			emit: (event: RuntimeEvent) => void,
			runtimeOptions: { readonly signal: AbortSignal },
		) => {
			approvalResolutions.push(input);
			emitRuntime = emit;
			signal = runtimeOptions.signal;
			if (options.approvalFailure) throw options.approvalFailure;
			await turnReleased;
			runtimeSettled = true;
			return turnRecord({
				clientTurnId: "client-session-node",
				turnId: "turn-session-node",
				message: "original",
			}, runtimeOptions.signal.aborted ? "interrupted" : "completed");
		},
		resolveClarification: async (
			input: { readonly requestId: string; readonly response: string },
			emit: (event: RuntimeEvent) => void,
			runtimeOptions: { readonly signal: AbortSignal },
		) => {
			clarificationResolutions.push(input);
			emitRuntime = emit;
			signal = runtimeOptions.signal;
			if (options.clarificationFailure) throw options.clarificationFailure;
			await turnReleased;
			runtimeSettled = true;
			return turnRecord({
				clientTurnId: "client-session-node",
				clientUserMessageId: "user-session-node",
				turnId: "turn-session-node",
				message: "original",
			}, runtimeOptions.signal.aborted ? "interrupted" : "completed");
		},
		submit: async (submission: TurnSubmission, emit: (event: RuntimeEvent) => void, options: { signal: AbortSignal }) => {
				submissions.push(submission);
				emitRuntime = emit;
				signal = options.signal;
				await waitForTurnRelease(options.signal);
				runtimeSettled = true;
				return turnRecord(submission, options.signal.aborted ? "interrupted" : "completed");
			},
			forceInterrupt: async (
				input: { readonly clientTurnId: string; readonly turnId: string },
				emit: (event: RuntimeEvent) => void,
			) => {
				forcedInterrupts += 1;
				const interrupted = turnRecord({
					clientTurnId: input.clientTurnId,
					turnId: input.turnId,
					message: "wait",
				}, "interrupted");
				emit({ type: "turn_interrupted", message: "turn interrupted" });
				return interrupted;
			},
		};
	const sessionCoordinator = options.sessions
		? gatewaySessionCoordinator(runtime, options.sessions)
		: undefined;
	const gateway = createNodeGateway({
		sessionId: "session-node",
		workspaceRoot: "/repo",
		provider: "openai",
		model: "gpt-test",
		toolNames: ["Read"],
			maxPromptTokens: options.maxPromptTokens,
			runtime,
			...(options.agentInteractiveRequests ? {
				agentInteractiveRequests: options.agentInteractiveRequests,
			} : {}),
			loadConversation: () => options.conversation ?? [],
		...(options.loadShellOutput ? { loadShellOutput: options.loadShellOutput } : {}),
		loadTurnRollouts: () => options.turnRollouts ?? [],
		sessionCommands: {
			fork: (input: {
				readonly sourceSessionId: string;
				readonly targetSessionId: string;
				readonly forkPoint?: number;
			}) => {
				sessionCommandCalls.push({ kind: "fork", ...input });
				return {
					sourceSessionId: input.sourceSessionId,
					targetSessionId: input.targetSessionId,
					forkPoint: input.forkPoint ?? 2,
					messageCount: input.forkPoint ?? 2,
				};
			},
			search: (query: string, workspaceRoot: string) => {
				sessionCommandCalls.push({ kind: "search", query, workspaceRoot });
				return [{ sessionId: "target", messageIndex: 3, role: "user", snippet: `match ${query}` }];
			},
			maintenance: (action: string, workspaceRoot: string) => {
				sessionCommandCalls.push({ kind: "maintenance", action, workspaceRoot });
				return action === "report"
					? { dryRun: true, workspaceSessionCount: 2, emptySessionCount: 1 }
					: { dryRun: false, action, affected: 1 };
			},
		},
		traceCommands: {
			inspect: () => [{ kind: "turn", turnId: "turn-1", status: "completed" }],
			export: () => [
				JSON.stringify({ kind: "turn", turn_id: "turn-1", status: "completed" }),
			],
			logs: () => ["runtime status=completed"],
			append: (sessionId, event) => { traceAppends.push({ sessionId, event: { ...event } }); },
		},
		fileHistoryCommands: {
			list: async () => [{
				snapshotId: "snapshot-1",
				turnId: "turn-1",
				toolName: "Edit",
				path: "src/app.ts",
			}],
			undo: async () => ({
				snapshotId: "snapshot-1",
				restoredPaths: ["src/app.ts"],
				deletedPaths: [],
			}),
		},
		...(options.memory ? {
			memoryCommands: {
				directory: async () => "/bounded/memory",
				scan: async () => memories.map((memory) => ({ ...memory })),
				remember: async (input: Record<string, unknown>) => {
					const memory = { filename: "saved.md", ...input };
					memories.push(memory);
					return memory;
				},
				forget: async (query: string) => {
					const removed = memories.filter((memory) => memory.name === query);
					for (const memory of removed) memories.splice(memories.indexOf(memory), 1);
					return removed;
				},
			},
		} : {}),
		...(options.backgroundTasks ? {
			backgroundTaskCommands: {
				list: () => [{
					taskId: "task-1",
					childSessionId: "child-1",
					profileId: "subagent",
					status: "running",
					payload: { progressSummary: "Inspecting" },
				}],
				interrupt: async (_parentSessionId: string, childSessionId: string) => {
					taskInterruptions.push(childSessionId);
					return childSessionId === "child-1";
				},
				interruptAll: async () => {
					taskInterruptions.push("*");
					return 1;
				},
			},
		} : {}),
		...(sessionCoordinator ? { sessionCoordinator } : {}),
		...(shell ? {
			shellManager: shell.manager,
			shellLifecycle: shell.lifecycle,
		} : {}),
		...(options.workspaceTrust ? {
			workspaceTrust: {
				initialState: "unknown" as const,
				load: async () => "unknown" as const,
				save: async () => undefined,
			},
		} : {}),
			...(integrations ? { integrations } : {}),
			...(options.control ? {
				controlCommands: {
					authProviders: async () => [{
						id: "openai",
						name: "OpenAI",
						configured: savedApiKeys.some((item) => item.providerId === "openai"),
						default_model: "gpt-test",
					}],
					saveApiKey: async (providerId: string, apiKey: string) => {
						savedApiKeys.push({ providerId, apiKey });
						return { ok: true, provider_id: providerId, message: `Saved API key for ${providerId}.` };
					},
					models: async () => [{
						provider: "openai",
						protocol: "responses",
						model: "gpt-test",
						name: "GPT Test",
						base_url: "https://example.invalid/v1",
						current: selectedModels.length === 0,
					}],
					selectModel: async (input: Readonly<Record<string, unknown>>) => {
						selectedModels.push({ ...input });
						return { ...input, name: String(input.model), current: true };
					},
					loadSettings: async () => ({ ...visualSettings }),
					saveSettings: async (settings: Readonly<Record<string, unknown>>) => {
						visualSettings = { ...settings };
						return { ...visualSettings };
					},
					completePath: async (prefix: string) => [{ value: `${prefix}README.md`, kind: "file" }],
				},
			} : {}),
			close: () => { closeCalls += 1; },
		createTurnId: () => "turn-node",
		clock: () => 1_700_000_000,
	});
	const messages: RpcMessage[] = [];
	const lines = createInterface({ input: gateway.transport.input, crlfDelay: Infinity });
	lines.on("line", (line) => { messages.push(parseJsonRpcMessage(JSON.parse(line))); });
	let requestId = 0;
	async function send(method: string, params: Record<string, unknown> = {}) {
		const id = String(++requestId);
		gateway.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return waitFor(() => messages.find((message) => "id" in message && String(message.id) === id));
	}
	return {
		gateway,
		messages,
		submissions,
		reservedClientTurnIds,
		policyConfigurations,
		runtimeContexts,
		approvalResolutions,
		clarificationResolutions,
		send,
		emit: (event: RuntimeEvent) => emitRuntime?.(event),
		signal: () => signal,
		releaseTurn,
		closeCalls: () => closeCalls,
			runtimeSettled: () => runtimeSettled,
			forcedInterrupts: () => forcedInterrupts,
		sessionCoordinator,
		queue,
		shell,
			publishSubagent: (subagent: Readonly<Record<string, unknown>>) => {
				for (const listener of subagentListeners) listener(subagent);
			},
			publishExtension: (version: number) => {
				for (const listener of extensionListeners) listener(version);
			},
		taskInterruptions,
		sessionCommandCalls,
		savedApiKeys,
		selectedModels,
		traceAppends,
	};
}

test("node gateway boots the real TUI startup sequence", async () => {
	const harness = gatewayHarness({
		conversation: [
			{ role: "user", content: "question" },
			{ role: "assistant", content: "answer" },
		],
	});
	const ready = await waitFor(() => notification(harness.messages, "runtime.ready"));
	assert.deepEqual(ready.params, { session_id: "session-node" });
	for (const [method, params] of [
		["initialize", { protocol_version: 1 }],
		["status.get", {}],
		["extension.manifest", {}],
		["session.bootstrap", { protocol_version: 1 }],
		["transcript.load", { session_id: "session-node", before: null }],
		["command.list", { surface: "tui" }],
		["settings.load", {}],
		["session.list", {}],
	] as const) {
		const response = await harness.send(method, params);
		assert.ok("result" in response, `${method} returned an error`);
		if (method === "transcript.load" && "result" in response) {
			assert.deepEqual(response.result.items, [
				{ id: "session-node:message:1", type: "user", text: "question", folded: false, metadata: {} },
				{ id: "session-node:message:2", type: "assistant_final", text: "answer", folded: false, metadata: {} },
			]);
		}
		if (method === "extension.manifest" && "result" in response) {
			assert.deepEqual(response.result.capabilities, {
				no_tool_turns: true,
				tools: true,
				tool_names: ["Read"],
			});
		}
	}
	await harness.gateway.close();
});

test("every advertised canonical TUI RPC is routed by the Node gateway", async () => {
	const harness = gatewayHarness({ control: true, sessions: {}, shell: true });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const advertised = await harness.send("extension.manifest");
	assert.ok("result" in advertised);
	const advertisedNames = new Set(
		"result" in advertised && Array.isArray(advertised.result.rpc_methods)
			? advertised.result.rpc_methods.flatMap((entry: unknown) => {
				if (typeof entry !== "object" || entry === null || Array.isArray(entry) || !("name" in entry)) return [];
				return typeof entry.name === "string" ? [entry.name] : [];
			})
			: [],
	);
	const probes = [
		["auth.api_key.save", {}],
		["clarify.respond", {}],
		["completion.path", {}],
		["completion.slash", {}],
		["decision.resolve", {}],
		["model.list", {}],
		["model.select", {}],
		["session.new", {}],
		["settings.save", {}],
		["shell.list", {}],
		["shell.output.load", {}],
		["shell.stop", {}],
		["shell.stop_all", {}],
		["status.inspect", {}],
		["trace.export", {}],
	] as const;
	for (const [method, params] of probes) {
		assert.equal(advertisedNames.has(method), true, `${method} is not advertised`);
		const result = await harness.send(method, params);
		assert.notEqual(
			"error" in result ? result.error.code : null,
			"method_not_found",
			`${method} is advertised but not routed`,
		);
	}
	await harness.gateway.close();
});

test("shell output RPC returns bounded append-only pages without changing transcript bootstrap", async () => {
	const calls: LoadShellOutputPageInput[] = [];
	const harness = gatewayHarness({
		loadShellOutput: (input) => {
			calls.push(input);
			return {
				sessionId: input.sessionId,
				shellId: input.shellId,
				callId: input.callId,
				chunks: [{
					sequence: 7,
					cursorStart: 12,
					cursorEnd: 17,
					omittedBefore: 12,
					output: "tail\n",
				}],
				nextAfterSequence: 7,
				available: true,
				complete: false,
				omittedChars: 12,
				capturedChars: 5,
				outputChars: 17,
			};
		},
	});
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	assert.equal(calls.length, 0);
	assert.doesNotMatch(JSON.stringify(harness.messages), /tail\\n/u);

	const response = await harness.send("shell.output.load", {
		session_id: "session-node",
		shell_id: "shell-a",
		call_id: "call-a",
		after_sequence: 3,
		limit_chars: 4096,
	});
	assert.deepEqual(calls, [{
		sessionId: "session-node",
		shellId: "shell-a",
		callId: "call-a",
		afterSequence: 3,
		limitChars: 4096,
	}]);
	assert.deepEqual("result" in response ? response.result : null, {
		session_id: "session-node",
		shell_id: "shell-a",
		call_id: "call-a",
		chunks: [{
			sequence: 7,
			cursor_start: 12,
			cursor_end: 17,
			omitted_before: 12,
			output: "tail\n",
		}],
		next_after_sequence: 7,
		available: true,
		complete: false,
		omitted_chars: 12,
		captured_chars: 5,
		output_chars: 17,
	});

	const invalid = await harness.send("shell.output.load", {
		shell_id: "shell-a",
		after_sequence: -1,
	});
	assert.equal("error" in invalid ? invalid.error.code : null, "invalid_params");
	await harness.gateway.close();
});

test("canonical control RPCs use injected Node services and update active state", async () => {
	const harness = gatewayHarness({ control: true });
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	const bootstrap = await harness.send("session.bootstrap", { protocol_version: 1 });
	assert.ok("result" in bootstrap);
	assert.equal("result" in bootstrap ? bootstrap.result.models.length : 0, 1);
	assert.equal("result" in bootstrap ? bootstrap.result.auth_providers[0]?.configured : null, false);

	const auth = await harness.send("auth.api_key.save", {
		provider_id: "openai",
		api_key: "test-secret-that-must-not-return",
	});
	assert.equal("result" in auth ? auth.result.ok : false, true);
	assert.equal(JSON.stringify(auth).includes("test-secret-that-must-not-return"), false);
	assert.deepEqual(harness.savedApiKeys, [{
		providerId: "openai",
		apiKey: "test-secret-that-must-not-return",
	}]);

	const models = await harness.send("model.list");
	assert.equal("result" in models ? models.result.models[0]?.model : null, "gpt-test");
	const selected = await harness.send("model.select", {
		provider: "openai",
		protocol: "responses",
		model: "gpt-selected",
		base_url: "https://example.invalid/v1",
		reasoning_effort: "high",
	});
	assert.equal("result" in selected ? selected.result.selected.model : null, "gpt-selected");
	assert.equal("result" in selected ? selected.result.status.model : null, "gpt-selected");
	assert.equal(harness.selectedModels.length, 1);

	const loadedSettings = await harness.send("settings.load");
	assert.equal("result" in loadedSettings ? loadedSettings.result.settings.view_mode : null, "default");
	const savedSettings = await harness.send("settings.save", {
		settings: { view_mode: "verbose", statusbar_mode: "compact" },
	});
	assert.equal("result" in savedSettings ? savedSettings.result.settings.view_mode : null, "verbose");

	const slash = await harness.send("completion.slash", { prefix: "/sta", surface: "tui" });
	assert.deepEqual("result" in slash ? slash.result.items : [], [{
		value: "/status",
		description: "Show runtime status",
	}]);
	const path = await harness.send("completion.path", { prefix: "@src/" });
	assert.deepEqual("result" in path ? path.result.items : [], [{ value: "@src/README.md", kind: "file" }]);

	const status = await harness.send("status.inspect");
	assert.equal("result" in status ? status.result.model : null, "gpt-selected");
	const trace = await harness.send("trace.export", { tail: 1 });
	assert.deepEqual("result" in trace ? trace.result : {}, {
		session_id: "session-node",
		format: "jsonl",
		rows: [JSON.stringify({ kind: "turn", turn_id: "turn-1", status: "completed" })],
	});
	await harness.gateway.close();
});

test("gateway owns permission selection and reconfigures runtime trust policy", async () => {
	const harness = gatewayHarness({ workspaceTrust: true });
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	const listed = await harness.send("permissions.list");
	assert.ok("result" in listed);
	assert.deepEqual("result" in listed ? listed.result : {}, permissionPayload("workspace"));
	assert.deepEqual(harness.policyConfigurations, [{
		trust: "unknown",
		permission: "workspace",
	}]);

	const trusted = await harness.send("workspace.trust.set", { state: "trusted" });
	assert.equal("result" in trusted ? trusted.result.enforced : null, true);
	const updated = await harness.send("permissions.update", { profile: "full-access" });
	assert.ok("result" in updated);
	assert.deepEqual(
		"result" in updated ? updated.result.permissions : {},
		permissionPayload("full-access"),
	);
	assert.deepEqual(harness.policyConfigurations.slice(-2), [
		{ trust: "trusted", permission: "workspace" },
		{ trust: "trusted", permission: "full-access" },
	]);

	const invalid = await harness.send("permissions.update", { profile: "invalid" });
	assert.equal("error" in invalid ? invalid.error.code : null, "invalid_params");
	assert.deepEqual(harness.policyConfigurations.at(-1), {
		trust: "trusted",
		permission: "full-access",
	});
	await harness.gateway.close();
});

test("shell bootstrap and control RPCs stay scoped to the active owner", async () => {
	const harness = gatewayHarness({ shell: true });
	assert.ok(harness.shell);
	harness.shell.snapshots.push(shellSnapshot({ ownerSessionId: "session-node" }));
	harness.shell.snapshots.push(shellSnapshot({
		ownerSessionId: "another-session",
		shellId: "deadbeef",
	}));

	const initialized = await harness.send("initialize", { protocol_version: 1 });
	assert.ok("result" in initialized);
	assert.deepEqual("result" in initialized ? initialized.result.background_shells : [], [
		assertedShellPayload("a1b2c3d4", 1),
	]);
	const listed = await harness.send("shell.list");
	assert.deepEqual("result" in listed ? listed.result.shells : [], [
		assertedShellPayload("a1b2c3d4", 1),
	]);
	const stopped = await harness.send("shell.stop", { shell_id: "a1b2c3d4" });
	assert.equal("result" in stopped ? stopped.result.shell_id : null, "a1b2c3d4");
	const stoppedAll = await harness.send("shell.stop_all");
	assert.equal("result" in stoppedAll ? stoppedAll.result.stopped : null, 1);
	assert.deepEqual(harness.shell.terminations, [
		{ ownerSessionId: "session-node", shellId: "a1b2c3d4" },
	]);
	assert.deepEqual(harness.shell.terminatedOwners, ["session-node"]);
	await harness.gateway.close();
});

test("shell command routes expose ps and stop through the active owner manager", async () => {
	const harness = gatewayHarness({ shell: true });
	assert.ok(harness.shell);
	harness.shell.snapshots.push(shellSnapshot());

	const listed = await harness.send("command.list", { surface: "tui" });
	assert.deepEqual(
		"result" in listed
			? listed.result.commands.map((command: { name: string }) => command.name)
			: [],
		TUI_BUILTIN_COMMAND_NAMES,
	);
	const ps = await harness.send("command.run", { command: "/ps", surface: "tui" });
	assert.equal("result" in ps ? ps.result.command_kind : null, "background_shells");
	assert.deepEqual("result" in ps ? ps.result.processes : [], [
		assertedShellPayload("a1b2c3d4", 1),
	]);
	const stopped = await harness.send("command.run", { command: "/ps stop-all", surface: "tui" });
	assert.equal("result" in stopped ? stopped.result.command_kind : null, "shell_stop");
	assert.deepEqual("result" in stopped ? stopped.result.lines : [], [
		"Stopping all background terminals.",
	]);
	assert.deepEqual(harness.shell.terminatedOwners, ["session-node"]);
	await harness.gateway.close();
});

test("built-in TUI slash commands resolve to their canonical client actions", async () => {
	const harness = gatewayHarness();
	const cases = [
		["/help", "help", "open_help", "", "none"],
		["/model", "model", "open_model_selector", "", "transcript"],
		["/permissions", "permissions", "open_permissions", "", "overlay"],
		["/session", "resume", "open_session_selector", "", "transcript"],
		["/agents", "agents", "open_agents", "", "transcript"],
		["/tasks", "agents", "open_agents", "", "transcript"],
		["/settings", "settings", "open_settings", "", "none"],
		["/resources", "resources", "open_resources", "", "none"],
		["/details", "details", "toggle_details", "", "none"],
		["/view focus", "view", "set_view_mode", "focus", "none"],
		["/hotkeys", "hotkeys", "open_hotkeys", "", "none"],
		["/copy", "copy", "copy_last_response", "", "none"],
		["/clear", "clear", "clear_transcript", "", "none"],
		["/login", "login", "open_login", "", "none"],
		["/trust", "trust", "open_trust", "", "none"],
		["/quit", "quit", "quit", "", "none"],
	] as const;
	for (const [command, commandId, action, args, presentation] of cases) {
		const response = await harness.send("command.run", { command, surface: "tui" });
		assert.deepEqual("result" in response ? response.result : response, {
			execution: "tui",
			command_id: commandId,
			client_action: action,
			args,
			presentation,
		});
	}
	await harness.gateway.close();
});

test("built-in slash validation returns stable local errors", async () => {
	const harness = gatewayHarness();
	for (const [command, surface, code] of [
		["/does-not-exist", "tui", "unknown_command"],
		["/plan now", "tui", "invalid_arguments"],
		["/new", "cli", "unavailable_surface"],
	] as const) {
		const response = await harness.send("command.run", { command, surface });
		assert.equal("error" in response ? response.error.code : null, code);
	}
	await harness.gateway.close();
});

test("integration commands are additive and cannot override built-in names or aliases", async () => {
	const harness = gatewayHarness({
		integrations: true,
		integrationCommands: [{
			id: "plugin:override:help",
			name: "/help",
			description: "Override help",
			argument_policy: "none",
			available_during_turn: true,
		}, {
			id: "plugin:override:session",
			name: "/session",
			description: "Override resume alias",
			argument_policy: "none",
			available_during_turn: true,
		}, {
			id: "plugin:demo:status",
			name: "/plugin:demo:status",
			description: "Show demo plugin status",
			argument_policy: "none",
			available_during_turn: true,
		}],
	});
	const listed = await harness.send("command.list", { surface: "tui" });
	assert.deepEqual(
		"result" in listed
			? listed.result.commands.map((command: { name: string }) => command.name)
			: [],
		[...TUI_BUILTIN_COMMAND_NAMES, "/plugin:demo:status"],
	);
	const help = await harness.send("command.run", { command: "/help", surface: "tui" });
	assert.equal("result" in help ? help.result.client_action : null, "open_help");
	await harness.gateway.close();
});

test("commands marked unavailable during a turn fail before execution", async () => {
	const harness = gatewayHarness();
	await harness.send("turn.submit", {
		message: "keep running",
		client_turn_id: "running-turn",
		client_user_message_id: "running-message",
		local_images: [],
	});
	const response = await harness.send("command.run", { command: "/new", surface: "tui" });
	assert.equal("error" in response ? response.error.code : null, "unavailable_during_turn");
	harness.releaseTurn();
	await harness.gateway.close();
});

test("core backend slash commands return bounded versioned display results", async () => {
	const harness = gatewayHarness({ integrations: true });
	for (const [command, surface, kind, presentation] of [
		["/status", "tui", "status", "transcript"],
		["/usage", "tui", "diagnostic", "transcript"],
		["/tools", "tui", "list", "overlay"],
		["/skills", "tui", "list", "overlay"],
		["/changes", "tui", "list", "transcript"],
		["/help", "cli", "list", "none"],
	] as const) {
		const response = await harness.send("command.run", { command, surface });
		assert.ok("result" in response, `${command} returned ${JSON.stringify(response)}`);
		if (!("result" in response)) continue;
		assert.equal(response.result.execution, "backend");
		assert.equal(response.result.presentation, presentation);
		assert.equal((response.result.display as { version?: unknown }).version, 1);
		assert.equal((response.result.display as { kind?: unknown }).kind, kind);
		assert.ok(Array.isArray(response.result.lines));
		assert.ok(response.result.lines.length <= 100);
	}
	await harness.gateway.close();
});

test("model slash settings apply to the next submitted Node turn", async () => {
	const harness = gatewayHarness({ control: true });
	const selected = await harness.send("command.run", {
		command: "/model gpt-test --thinking-effort high",
		surface: "tui",
	});
	assert.equal("result" in selected ? selected.result.mutated_model : false, true);
	assert.equal("result" in selected ? selected.result.model : null, "gpt-test");
	assert.equal("result" in selected ? selected.result.thinking_effort : null, "high");
	const status = await harness.send("command.run", { command: "/status", surface: "tui" });
	const statusFields = "result" in status
		? (status.result.display as { fields: readonly { label: string; value: string }[] }).fields
		: [];
	assert.equal(statusFields.find((field) => field.label === "Model")?.value, "gpt-test");
	await harness.send("turn.submit", {
		message: "use selected model",
		client_turn_id: "model-turn",
		client_user_message_id: "model-message",
		local_images: [],
	});
	assert.equal(harness.submissions[0]?.modelOverride, "gpt-test");
	assert.equal(harness.submissions[0]?.reasoningEffort, "high");
	harness.releaseTurn();
	await harness.gateway.close();
});

test("mode sandbox resume and quit slash commands mutate their owning runtime state", async () => {
	const harness = gatewayHarness({ sessions: {} });
	const mode = await harness.send("command.run", { command: "/mode plan", surface: "tui" });
	assert.equal("result" in mode ? mode.result.collaboration_mode : null, "plan");
	assert.equal("result" in mode ? mode.result.mutated_mode : false, true);
	assert.equal(harness.runtimeContexts.at(-1)?.collaborationMode, "plan");
	const sandbox = await harness.send("command.run", {
		command: "/sandbox read-only",
		surface: "tui",
	});
	assert.equal("result" in sandbox ? sandbox.result.sandbox_mode : null, "read-only");
	const permissions = await harness.send("permissions.list");
	assert.equal("result" in permissions ? permissions.result.active : null, "read-only");
	const resumed = await harness.send("command.run", {
		command: "/resume target",
		surface: "tui",
	});
	assert.equal("result" in resumed ? resumed.result.mutated_session : false, true);
	assert.equal("result" in resumed ? resumed.result.session_id : null, "target");
	const status = await harness.send("status.get");
	assert.equal("result" in status ? status.result.collaboration_mode : null, "plan");
	const quit = await harness.send("command.run", { command: "/quit", surface: "cli" });
	assert.equal("result" in quit ? quit.result.exit_requested : false, true);
	await harness.gateway.close();
});

test("new slash command switches to a fresh backend session generation", async () => {
	const harness = gatewayHarness({ sessions: {} });

	const created = await harness.send("command.run", { command: "/new", surface: "tui" });

	assert.equal("result" in created ? created.result.mutated_session : false, true);
	assert.equal("result" in created ? created.result.session_id : null, "fresh-1");
	const status = await harness.send("status.get");
	assert.equal("result" in status ? status.result.session_id : null, "fresh-1");
	const sessions = await harness.send("session.list");
	assert.equal(
		"result" in sessions
			? sessions.result.sessions.some((session: { id?: string; current?: boolean }) =>
				session.id === "fresh-1" && session.current === true)
			: false,
		true,
	);
	await harness.gateway.close();
});

test("context stats and task slash commands project existing Node runtime state", async () => {
	const harness = gatewayHarness({
		integrations: true,
		maxPromptTokens: 1_000,
		turnRollouts: [{
			continuation_state: {
				usage: { input_tokens: 400, output_tokens: 25, total_tokens: 425 },
			},
		}],
	});
	for (const [command, kind, title] of [
		["/context", "diagnostic", "Context"],
		["/stats", "diagnostic", "Runtime stats"],
		["/agents runs", "list", "Background agents"],
		["/tasks agents", "list", "Background agents"],
	] as const) {
		const response = await harness.send("command.run", { command, surface: "tui" });
		assert.ok("result" in response, `${command} returned ${JSON.stringify(response)}`);
		if (!("result" in response)) continue;
		const display = response.result.display as { kind?: unknown; title?: unknown };
		assert.equal(display.kind, kind);
		assert.equal(display.title, title);
	}
	const context = await harness.send("command.run", { command: "/context", surface: "tui" });
	const fields = "result" in context
		? (context.result.display as { fields: readonly { label: string; value: string }[] }).fields
		: [];
	assert.equal(fields.find((field) => field.label === "Used tokens")?.value, "400");
	assert.equal(fields.find((field) => field.label === "Max tokens")?.value, "1000");
	assert.equal(fields.find((field) => field.label === "Usage ratio")?.value, "40%");
	assert.equal(fields.find((field) => field.label === "Source")?.value, "provider_aggregate");
	const legacyStatus = await harness.send("status.get");
	assert.equal(
		"result" in legacyStatus
			? (legacyStatus.result.context_window as Readonly<Record<string, unknown>>).source
			: undefined,
		"provider_aggregate",
	);
	await harness.gateway.close();
});

test("context stats prefer the last provider step over accumulated turn usage", async () => {
	const harness = gatewayHarness({
		maxPromptTokens: 1_000,
		turnRollouts: [{
			continuation_state: {
				usage: { input_tokens: 400, output_tokens: 25, total_tokens: 425 },
				last_token_usage: { input_tokens: 150, output_tokens: 10, total_tokens: 160 },
			},
		}],
	});
	const context = await harness.send("command.run", { command: "/context", surface: "tui" });
	const contextFields = "result" in context
		? (context.result.display as { fields: readonly { label: string; value: string }[] }).fields
		: [];
	assert.equal(contextFields.find((field) => field.label === "Used tokens")?.value, "150");
	assert.equal(contextFields.find((field) => field.label === "Usage ratio")?.value, "15%");
	assert.equal(contextFields.find((field) => field.label === "Source")?.value, "provider");

	const usage = await harness.send("command.run", { command: "/usage", surface: "tui" });
	const usageFields = "result" in usage
		? (usage.result.display as { fields: readonly { label: string; value: string }[] }).fields
		: [];
	assert.equal(usageFields.find((field) => field.label === "Input tokens")?.value, "400");

	const status = await harness.send("status.get");
	const contextWindow = "result" in status
		? status.result.context_window as Readonly<Record<string, unknown>>
		: {};
	assert.equal(contextWindow.used_tokens, 150);
	assert.equal(contextWindow.source, "provider");
	await harness.gateway.close();
});

test("memory slash commands use the Node memory adapter and keep mutations in transcript", async () => {
	const harness = gatewayHarness({ memory: true });
	for (const [command, kind, presentation] of [
		["/memory list", "list", "overlay"],
		["/memory path", "diagnostic", "overlay"],
		["/memory search Architecture", "list", "overlay"],
		["/memory add user Architecture :: Prefer clear boundaries", "notice", "transcript"],
		["/memory forget Architecture", "notice", "transcript"],
	] as const) {
		const response = await harness.send("command.run", { command, surface: "tui" });
		assert.ok("result" in response, `${command} returned ${JSON.stringify(response)}`);
		if (!("result" in response)) continue;
		assert.equal((response.result.display as { kind?: unknown }).kind, kind);
		assert.equal(response.result.presentation, presentation);
	}
	await harness.gateway.close();
});

test("permission slash mutations update session command allowances", async () => {
	const harness = gatewayHarness();
	const inspected = await harness.send("command.run", {
		command: "/permissions",
		surface: "cli",
	});
	assert.equal(
		"result" in inspected
			? (inspected.result.display as { kind?: unknown }).kind
			: null,
		"list",
	);
	for (const command of [
		"/permissions allow git status",
		"/permissions allow npm test",
		"/permissions revoke git status",
	]) {
		const response = await harness.send("command.run", { command, surface: "tui" });
		assert.equal("result" in response ? response.result.presentation : null, "transcript");
	}
	let permissions = await harness.send("permissions.list");
	assert.equal("result" in permissions ? permissions.result.command_allowance_count : null, 1);
	const cleared = await harness.send("command.run", {
		command: "/permissions clear",
		surface: "cli",
	});
	assert.equal("result" in cleared ? cleared.result.cleared : null, 1);
	permissions = await harness.send("permissions.list");
	assert.equal("result" in permissions ? permissions.result.command_allowance_count : null, 0);
	await harness.gateway.close();
});

test("task slash commands list and interrupt only current-session background agents", async () => {
	const harness = gatewayHarness({ backgroundTasks: true });
	const listed = await harness.send("command.run", {
		command: "/tasks agents",
		surface: "tui",
	});
	assert.deepEqual(
		"result" in listed
			? (listed.result.display as { rows: readonly { label: string }[] }).rows.map((row) => row.label)
			: [],
		["child-1"],
	);
	const one = await harness.send("command.run", {
		command: "/tasks agents kill child-1",
		surface: "tui",
	});
	assert.equal("result" in one ? one.result.interrupted : null, true);
	const all = await harness.send("command.run", {
		command: "/tasks kill-agents",
		surface: "tui",
	});
	assert.equal("result" in all ? all.result.interrupted : null, 1);
	assert.deepEqual(harness.taskInterruptions, ["child-1", "*"]);
	await harness.gateway.close();
});

test("compact slash command runs the Node manual compaction boundary", async () => {
	const harness = gatewayHarness();
	const response = await harness.send("command.run", { command: "/compact", surface: "tui" });
	assert.ok("result" in response, JSON.stringify(response));
	if ("result" in response) {
		assert.equal(response.result.command_kind, "compact");
		assert.equal(response.result.compaction_status, "compressed");
		assert.equal((response.result.display as { kind?: unknown }).kind, "notice");
		assert.deepEqual(response.result.tokens, { before: 900, after: 300 });
	}
	await harness.gateway.close();
});

test("undo slash command restores the latest recoverable Node file snapshot", async () => {
	const harness = gatewayHarness();
	const listed = await harness.send("command.run", { command: "/changes", surface: "tui" });
	assert.deepEqual(
		"result" in listed
			? (listed.result.display as { rows: readonly { label: string }[] }).rows.map((row) => row.label)
			: [],
		["src/app.ts"],
	);
	const response = await harness.send("command.run", { command: "/undo", surface: "tui" });
	assert.ok("result" in response, JSON.stringify(response));
	if ("result" in response) {
		assert.equal((response.result.display as { kind?: unknown }).kind, "notice");
		assert.equal(response.result.presentation, "transcript");
		assert.equal(response.result.snapshot_id, "snapshot-1");
		assert.equal((response.result.display as { summary?: unknown }).summary, "restored src/app.ts");
	}
	await harness.gateway.close();
});

test("fork search and maintenance slash commands use Node session storage", async () => {
	const harness = gatewayHarness({ sessions: {} });
	const forked = await harness.send("command.run", {
		command: "/fork session-node branch 1",
		surface: "tui",
	});
	assert.equal("result" in forked ? forked.result.mutated_session : false, true);
	assert.equal("result" in forked ? forked.result.session_id : null, "branch");
	assert.equal(harness.sessionCoordinator?.snapshot().sessionId, "branch");

	const searched = await harness.send("command.run", {
		command: "/session search cache hits",
		surface: "tui",
	});
	assert.equal("result" in searched
		? (searched.result.display as { kind?: unknown }).kind
		: null, "list");
	assert.equal("result" in searched
		? (searched.result.display as { rows: readonly { label: string }[] }).rows[0]?.label
		: null, "target:3");

	for (const [command, action, kind] of [
		["/session maintenance", "report", "list"],
		["/session maintenance --apply-empty", "empty", "notice"],
		["/session maintenance --apply-orphans", "orphans", "notice"],
		["/session maintenance --apply-vacuum", "vacuum", "notice"],
	] as const) {
		const response = await harness.send("command.run", { command, surface: "tui" });
		assert.equal("result" in response
			? (response.result.display as { kind?: unknown }).kind
			: null, kind);
		assert.ok(harness.sessionCommandCalls.some((call) => call.action === action));
	}
	await harness.gateway.close();
});

test("tools subactions and trace commands return filtered bounded displays", async () => {
	const harness = gatewayHarness({ integrations: true });
	for (const [command, title, labels] of [
		["/tools list", "Tools", ["Read", "Skill", "McpSearch"]],
		["/tools sets", "Tool sets", ["external", "file"]],
		["/tools extensions", "Extensions", ["Skill", "McpSearch"]],
		["/tools plugins", "Plugins", ["docs README", "/plugin:demo:status"]],
	] as const) {
		const response = await harness.send("command.run", { command, surface: "tui" });
		assert.ok("result" in response, `${command} returned ${JSON.stringify(response)}`);
		if (!("result" in response)) continue;
		const display = response.result.display as {
			readonly title: string;
			readonly rows: readonly { readonly label: string }[];
		};
		assert.equal(display.title, title);
		assert.deepEqual(display.rows.map((row) => row.label), labels);
	}

	for (const [command, kind, title, presentation] of [
		["/trace", "list", "Trace", "overlay"],
		["/trace export", "preformatted", "Trace export", "transcript"],
		["/trace logs", "preformatted", "Trace logs", "overlay"],
	] as const) {
		const response = await harness.send("command.run", { command, surface: "tui" });
		assert.ok("result" in response, `${command} returned ${JSON.stringify(response)}`);
		if (!("result" in response)) continue;
		const display = response.result.display as { readonly kind: string; readonly title: string };
		assert.equal(display.kind, kind);
		assert.equal(display.title, title);
		assert.equal(response.result.presentation, presentation);
		assert.ok(response.result.lines.length <= 100);
	}
	const plugin = await harness.send("command.run", {
		command: "/tools plugins demo status {}",
		surface: "tui",
	});
	assert.equal("result" in plugin ? plugin.result.presentation : null, "transcript");
	assert.equal(
		"result" in plugin
			? (plugin.result.display as { preformatted?: unknown }).preformatted
			: null,
		"demo ready",
	);
	await harness.gateway.close();
});

test("malformed backend slash subactions return structured bounded errors", async () => {
	const harness = gatewayHarness({ integrations: true, sessions: {} });
	for (const command of [
		"/fork source target nope",
		"/fork a b 1 extra",
		"/session search",
		"/session maintenance --delete-all",
		"/trace raw",
		"/tools unknown",
	]) {
		const response = await harness.send("command.run", { command, surface: "tui" });
		assert.ok("result" in response, `${command} returned ${JSON.stringify(response)}`);
		if (!("result" in response)) continue;
		const display = response.result.display as {
			readonly version: number;
			readonly kind: string;
			readonly summary: string;
		};
		assert.equal(display.version, 1);
		assert.equal(display.kind, "error");
		assert.ok(display.summary.length <= 2_048);
		assert.ok(response.result.lines.length <= 100);
	}
	await harness.gateway.close();
});

test("gateway exposes bounded integration manifests resources commands and subagent updates", async () => {
	const harness = gatewayHarness({ integrations: true });
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	const manifest = await harness.send("extension.manifest");
	assert.deepEqual(
		"result" in manifest
			? (manifest.result.tool_manifest as { tools: readonly { name: string }[] }).tools.map(
				(tool) => tool.name,
			)
			: [],
		["Read", "Skill", "McpSearch"],
	);

	const resources = await harness.send("resource.list");
	assert.deepEqual("result" in resources ? resources.result.resources : [], [{
		id: "skill:review",
		type: "skill",
		name: "review",
		source: "repo",
		enabled: true,
		status: "enabled",
		detail: "Review changes",
		command: "/tools skills",
	}, {
		id: "mcp:docs:file:///README.md",
		type: "plugin",
		name: "docs README",
		source: "runtime",
		enabled: true,
		status: "enabled",
		detail: "MCP resource file:///README.md",
		command: "/mcp inspect docs",
	}]);
	assert.equal(JSON.stringify(resources).includes("body"), false);

	const commands = await harness.send("command.list", { surface: "tui" });
	assert.deepEqual(
		"result" in commands
			? commands.result.commands.map((command: { name: string }) => command.name)
			: [],
		[...TUI_BUILTIN_COMMAND_NAMES, "/plugin:demo:status"],
	);
	const command = await harness.send("command.run", {
		command: "/plugin:demo:status",
		surface: "tui",
	});
	assert.deepEqual("result" in command ? command.result.lines : [], ["demo ready"]);

	harness.publishSubagent({
		run_id: "task-1",
		child_session_id: "child-1",
		role: "explore",
		status: "running",
		summary: "Exploring",
		progress: [],
		report: "raw child report",
		provider_response: { secret: "must not cross gateway" },
	});
	const event = await waitFor(() => notification(harness.messages, "subagent.updated"));
	assert.deepEqual(event.params.subagent, {
		run_id: "task-1",
		child_session_id: "child-1",
		role: "explore",
		status: "running",
		summary: "Exploring",
		progress: [],
	});
	parseGatewayEvent(event);
	await harness.gateway.close();
});

test("subagent updates filter stale parent sessions after resume", async () => {
	const harness = gatewayHarness({ integrations: true, sessions: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	harness.publishSubagent({
		parent_session_id: "session-node",
		run_id: "task-source",
		child_session_id: "child-source",
		role: "explore",
		status: "running",
		summary: "Source progress",
		progress: [],
	});
	await waitFor(() => notification(harness.messages, "subagent.updated"));
	await harness.send("session.resume", { session_id: "target" });

	const before = notifications(harness.messages, "subagent.updated").length;
	harness.publishSubagent({
		parent_session_id: "session-node",
		run_id: "task-stale",
		child_session_id: "child-stale",
		role: "explore",
		status: "completed",
		summary: "Stale completion",
		progress: [],
	});
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(notifications(harness.messages, "subagent.updated").length, before);

	harness.publishSubagent({
		parent_session_id: "target",
		run_id: "task-target",
		child_session_id: "child-target",
		role: "review",
		status: "running",
		summary: "Target progress",
		progress: [],
	});
	const current = await waitFor(() => notifications(harness.messages, "subagent.updated")
		.find((message) => message.params.subagent.run_id === "task-target"));
	assert.equal("parent_session_id" in current.params.subagent, false);
	parseGatewayEvent(current);
	await harness.gateway.close();
});

test("extension refresh publishes one schema-valid direct notification", async () => {
	const harness = gatewayHarness({ integrations: true });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	harness.publishExtension(2);
	const event = await waitFor(() => notification(harness.messages, "extension.updated"));
	assert.deepEqual(event.params, { version: 2 });
	parseGatewayEvent(event);
	assert.equal(notifications(harness.messages, "runtime.event").some(
		(message) => message.params.type === "extension.updated",
	), false);
	await harness.gateway.close();
});

test("shell lifecycle filters stale sessions and publishes the active generation", async () => {
	const harness = gatewayHarness({ shell: true, sessions: {} });
	assert.ok(harness.shell);
	harness.shell.publish(shellLifecycle({
		ownerSessionId: "session-node",
		kind: "shell.output",
		outputDelta: "source",
		nextCursor: 6,
	}));
	const source = await waitFor(() => notification(harness.messages, "shell.output"));
	assert.equal(source.params.session_id, "session-node");
	assert.equal(source.params.generation, 1);

	harness.shell.snapshots.push(shellSnapshot({
		ownerSessionId: "target",
		shellId: "e5f6a7b8",
		callId: "call-target",
	}));
	await harness.send("session.resume", { session_id: "target" });
	const targetStatus = await waitFor(() => notificationForSession(
		harness.messages,
		"status.changed",
		"target",
	));
	assert.deepEqual(targetStatus.params.background_shells, [
		assertedShellPayload("e5f6a7b8", 2, "target", "call-target"),
	]);
	const before = notifications(harness.messages, "shell.output").length;
	harness.shell.publish(shellLifecycle({
		ownerSessionId: "session-node",
		kind: "shell.output",
		sequence: 2,
		outputDelta: "stale",
		nextCursor: 11,
	}));
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(notifications(harness.messages, "shell.output").length, before);

	harness.shell.publish(shellLifecycle({
		ownerSessionId: "target",
		shellId: "e5f6a7b8",
		callId: "call-target",
		kind: "shell.output",
		outputDelta: "target",
		nextCursor: 6,
	}));
	const target = await waitFor(() => notifications(harness.messages, "shell.output")
		.find((message) => message.params.session_id === "target"));
	assert.equal(target.params.generation, 2);
	assert.equal(target.params.output_delta, "target");
	parseGatewayEvent(target);
	await harness.gateway.close();
});

test("session RPCs atomically resume and publish one target generation", async () => {
	const harness = gatewayHarness({ sessions: { targetPendingApproval: true } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	const listed = await harness.send("session.list", {});
	assert.ok("result" in listed);
	assert.deepEqual(
		"result" in listed
			? listed.result.sessions.map((item: { id: string; current: boolean }) => [item.id, item.current])
			: [],
		[["target", false], ["session-node", true]],
	);
	const tree = await harness.send("session.tree", { session_id: "target" });
	assert.deepEqual("result" in tree ? tree.result.active_path : null, ["session-node"]);

	const resumed = await harness.send("session.resume", { session_id: "target" });
	assert.deepEqual("result" in resumed ? resumed.result : null, {
		session_id: "target",
		generation: 2,
		read_only: false,
		lines: [],
		background_shells: [],
	});
	assert.equal(harness.sessionCoordinator?.snapshot().sessionId, "target");

	const changed = await waitFor(() => notificationForSession(
		harness.messages,
		"session.changed",
		"target",
	));
	const status = await waitFor(() => notificationForSession(
		harness.messages,
		"status.changed",
		"target",
	));
	const approval = await waitFor(() => notificationForSession(
		harness.messages,
		"approval.request",
		"target",
	));
	assert.ok(harness.messages.indexOf(changed) < harness.messages.indexOf(status));
	assert.ok(harness.messages.indexOf(status) < harness.messages.indexOf(approval));
	assert.equal(changed.params.generation, 2);
	assert.equal(approval.params.decision_id, "decision-target");
	parseGatewayEvent(changed);
	parseGatewayEvent(status);
	parseGatewayEvent(approval);

	const transcript = await harness.send("transcript.load", {
		session_id: "target",
		before: null,
	});
	assert.deepEqual("result" in transcript ? transcript.result : null, {
		session_id: "target",
		items: [{
			id: "target:user:1",
			type: "user",
			text: "target",
			created_at: "",
			folded: false,
			metadata: {},
		}],
		next_before: null,
		read_only: false,
	});
	await harness.gateway.close();
});

test("approval respond resumes the owning turn without reserving a new turn", async () => {
	const harness = gatewayHarness({ sessions: { initialPendingApproval: true } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	const response = await harness.send("approval.respond", {
		decision_id: "decision-session-node",
		choice: "approve_once",
		session_id: "session-node",
		generation: 1,
	});

	assert.ok("result" in response, JSON.stringify(response));
	assert.deepEqual("result" in response ? response.result : null, {
		accepted: true,
		decision_id: "decision-session-node",
		client_turn_id: "client-session-node",
		turn_id: "turn-session-node",
		session_id: "session-node",
		generation: 1,
	});
	assert.deepEqual(harness.approvalResolutions, [{
		decisionId: "decision-session-node",
		choice: "approve_once",
	}]);
	assert.deepEqual(harness.reservedClientTurnIds, []);
	const projected = await waitFor(() => notification(harness.messages, "approval.respond"));
	assert.equal(projected.params.generation, 1);
	parseGatewayEvent(projected);

	harness.releaseTurn();
	await harness.gateway.close();
});

test("clarification bootstrap re-emits the request and response resumes the owning turn", async () => {
	const harness = gatewayHarness({ sessions: { initialPendingClarification: true } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	await harness.send("session.bootstrap", { protocol_version: 1 });
	const request = await waitFor(() => notification(harness.messages, "clarify.request"));
	assert.deepEqual(request.params, {
		session_id: "session-node",
		generation: 1,
		client_turn_id: "client-session-node",
		turn_id: "turn-session-node",
		request_id: "question-session-node",
		tool_id: "question-session-node",
		call_id: "question-session-node",
		tool_name: "AskUserQuestion",
		question: "Which runtime?",
		options: [{ label: "Node" }, { label: "Python" }, { label: "Other" }],
		header: "Runtime",
		multi_select: false,
	});
	parseGatewayEvent(request);

	const response = await harness.send("clarify.respond", {
		request_id: "question-session-node",
		response: "Node",
	});
	assert.deepEqual("result" in response ? response.result : null, {
		accepted: true,
		request_id: "question-session-node",
		client_turn_id: "client-session-node",
		turn_id: "turn-session-node",
		session_id: "session-node",
		generation: 1,
	});
	assert.deepEqual(harness.clarificationResolutions, [{
		requestId: "question-session-node",
		response: "Node",
	}]);
	assert.deepEqual(harness.reservedClientTurnIds, []);
	assert.equal(harness.sessionCoordinator?.snapshot().pendingClarification, undefined);
	const projected = await waitFor(() => notification(harness.messages, "clarify.respond"));
	parseGatewayEvent(projected);

	harness.releaseTurn();
	await harness.gateway.close();
});

test("approval respond accepts always allow only when the pending backend option offers it", async () => {
	const harness = gatewayHarness({
		sessions: {
			initialPendingApproval: true,
			approvalOptions: ["approve_once", "reject", "allow_session", "always_allow"],
		},
	});
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	const response = await harness.send("approval.respond", {
		decision_id: "decision-session-node",
		choice: "always_allow",
		generation: 1,
	});

	assert.ok("result" in response, JSON.stringify(response));
	assert.deepEqual(harness.approvalResolutions, [{
		decisionId: "decision-session-node",
		choice: "always_allow",
	}]);
	harness.releaseTurn();
	await harness.gateway.close();
});

test("child approval routes by session while the root turn is running", async () => {
	let listener: ((notification: AgentInteractiveNotification) => void) | undefined;
	const responses: Record<string, unknown>[] = [];
	const interactive: AgentInteractiveRequestGateway = {
		subscribe: (next) => {
			listener = next;
			return () => { listener = undefined; };
		},
		pending: () => [],
		respondApproval: (params) => {
			if (params.session_id !== "child-session") return undefined;
			responses.push(params);
			return {
				accepted: true,
				decision_id: params.decision_id,
				session_id: params.session_id,
				generation: params.generation,
			};
		},
		respondClarification: () => undefined,
	};
	const harness = gatewayHarness({ agentInteractiveRequests: interactive });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const submitted = await harness.send("turn.submit", {
		message: "root remains active",
		client_turn_id: "root-turn",
		client_user_message_id: "root-message",
	});
	assert.equal("result" in submitted ? submitted.result.accepted : false, true);
	listener?.({
		method: "approval.request",
		params: {
			session_id: "child-session",
			child_session_id: "child-session",
			generation: 7,
			client_turn_id: "child-turn",
			decision_id: "child-decision",
			preview: "npm test",
			options: [{ choice: "approve_once", label: "Approve once" }],
		},
	});
	const request = await waitFor(() => notification(harness.messages, "approval.request"));
	assert.equal(request.params.session_id, "child-session");

	const response = await harness.send("approval.respond", {
		session_id: "child-session",
		generation: 7,
		decision_id: "child-decision",
		choice: "approve_once",
	});

	assert.ok("result" in response, JSON.stringify(response));
	assert.deepEqual(responses, [{
		session_id: "child-session",
		generation: 7,
		decision_id: "child-decision",
		choice: "approve_once",
	}]);
	harness.releaseTurn();
	await harness.gateway.close();
});

test("gateway serializes simultaneous root and child approval requests", async () => {
	let listener: ((notification: AgentInteractiveNotification) => void) | undefined;
	const interactive: AgentInteractiveRequestGateway = {
		subscribe: (next) => {
			listener = next;
			return () => { listener = undefined; };
		},
		pending: () => [],
		respondApproval: () => undefined,
		respondClarification: () => undefined,
	};
	const harness = gatewayHarness({
		sessions: { initialPendingApproval: true },
		agentInteractiveRequests: interactive,
	});
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("session.bootstrap", { protocol_version: 1 });
	await waitFor(() => notificationForSession(
		harness.messages,
		"approval.request",
		"session-node",
	));

	listener?.({
		method: "approval.request",
		params: {
			session_id: "child-session",
			child_session_id: "child-session",
			generation: 7,
			client_turn_id: "child-turn",
			decision_id: "child-decision",
			preview: "npm test",
			options: [{ choice: "approve_once", label: "Approve once" }],
		},
	});
	assert.equal(notificationCount(harness.messages, "approval.request"), 1);

	const response = await harness.send("approval.respond", {
		decision_id: "decision-session-node",
		choice: "approve_once",
		session_id: "session-node",
		generation: 1,
	});
	assert.ok("result" in response, JSON.stringify(response));
	const childRequest = await waitFor(() => notificationForSession(
		harness.messages,
		"approval.request",
		"child-session",
	));
	assert.equal(childRequest.params.decision_id, "child-decision");
	assert.deepEqual(
		notifications(harness.messages, "approval.request").map((message) => message.params.session_id),
		["session-node", "child-session"],
	);

	harness.releaseTurn();
	await harness.gateway.close();
});

test("gateway blocks session resume while the broker owns a child interaction", async () => {
	let listener: ((notification: AgentInteractiveNotification) => void) | undefined;
	const interactive: AgentInteractiveRequestGateway = {
		subscribe: (next) => {
			listener = next;
			return () => { listener = undefined; };
		},
		pending: () => [{
			sessionId: "child-session",
			generation: 7,
			agentPath: "/root/child",
			workerName: "child",
			kind: "approval",
			clientTurnId: "child-turn",
			turnId: "child-turn",
			requestId: "child-decision",
			toolName: "Shell",
		}],
		respondApproval: () => undefined,
		respondClarification: () => undefined,
	};
	const harness = gatewayHarness({ agentInteractiveRequests: interactive, sessions: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	listener?.({
		method: "approval.request",
		params: {
			session_id: "child-session",
			child_session_id: "child-session",
			generation: 7,
			client_turn_id: "child-turn",
			decision_id: "child-decision",
			preview: "npm test",
			options: [{ choice: "approve_once", label: "Approve once" }],
		},
	});
	await waitFor(() => notificationForSession(harness.messages, "approval.request", "child-session"));

	const resumed = await harness.send("session.resume", { session_id: "target" });
	assert.equal("error" in resumed ? resumed.error.code : null, "turn_in_progress");
	assert.equal(harness.sessionCoordinator?.snapshot().sessionId, "session-node");
	await harness.gateway.close();
});

test("gateway removes a broker-cancelled child request before presenting the next interaction", async () => {
	let listener: ((notification: AgentInteractiveNotification) => void) | undefined;
	const interactive: AgentInteractiveRequestGateway = {
		subscribe: (next) => {
			listener = next;
			return () => { listener = undefined; };
		},
		pending: () => [],
		respondApproval: () => undefined,
		respondClarification: () => undefined,
	};
	const harness = gatewayHarness({ agentInteractiveRequests: interactive, sessions: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	listener?.({
		method: "approval.request",
		params: {
			session_id: "child-one",
			child_session_id: "child-one",
			generation: 1,
			client_turn_id: "child-turn-one",
			decision_id: "child-decision-one",
			preview: "npm test",
			options: [{ choice: "approve_once", label: "Approve once" }],
		},
	});
	listener?.({
		method: "clarify.request",
		params: {
			session_id: "child-two",
			child_session_id: "child-two",
			generation: 2,
			client_turn_id: "child-turn-two",
			request_id: "child-question-two",
			tool_id: "question-call-two",
			call_id: "question-call-two",
			tool_name: "AskUserQuestion",
			question: "Continue?",
			options: [{ label: "Yes" }],
			multi_select: false,
		},
	});
	await waitFor(() => notificationForSession(harness.messages, "approval.request", "child-one"));
	assert.equal(notification(harness.messages, "clarify.request"), undefined);

	listener?.({
		method: "interactive.cancelled",
		params: {
			session_id: "child-one",
			child_session_id: "child-one",
			generation: 1,
			client_turn_id: "child-turn-one",
			decision_id: "child-decision-one",
		},
	});
	const clarification = await waitFor(() => notificationForSession(
		harness.messages,
		"clarify.request",
		"child-two",
	));
	assert.equal(clarification.params.request_id, "child-question-two");
	await harness.gateway.close();
});

test("approval respond rejects unsupported choices stale generations and wrong decisions", async () => {
	const harness = gatewayHarness({ sessions: { initialPendingApproval: true } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	for (const params of [
		{ decision_id: "decision-session-node", choice: "allow_session", generation: 1 },
		{ decision_id: "decision-session-node", choice: "approve_once", generation: 2 },
		{ decision_id: "wrong", choice: "approve_once", generation: 1 },
	]) {
		const response = await harness.send("approval.respond", params);
		assert.ok("error" in response);
		assert.equal(
			"error" in response ? response.error.code : null,
			params.choice === "allow_session" ? "invalid_params" : "approval_not_pending",
		);
	}
	assert.deepEqual(harness.approvalResolutions, []);

	harness.releaseTurn();
	await harness.gateway.close();
});

test("approval resolution failure restores the pending request without terminating the turn", async () => {
	const harness = gatewayHarness({
		approvalFailure: new StorageFailure("approval persistence failed"),
		sessions: { initialPendingApproval: true },
	});
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const approvalRequestCount = notificationCount(harness.messages, "approval.request");

	const response = await harness.send("approval.respond", {
		decision_id: "decision-session-node",
		choice: "approve_once",
		generation: 1,
	});

	assert.ok("result" in response, JSON.stringify(response));
	await waitFor(() => notificationCount(harness.messages, "approval.request") === approvalRequestCount + 1);
	const approvalRequests = harness.messages.filter((message) =>
		"method" in message && !("id" in message) && message.method === "approval.request",
	);
	assert.equal(approvalRequests.at(-1)?.params.decision_id, "decision-session-node");
	assert.equal(harness.sessionCoordinator?.snapshot().pendingApproval?.decisionId, "decision-session-node");
	assert.equal(notificationCount(harness.messages, "turn.failed"), 0);
	const statusUpdates = harness.messages.filter((message) =>
		"method" in message && !("id" in message) && message.method === "status.update",
	);
	assert.equal(statusUpdates.at(-1)?.params.state, "waiting_approval");
	const error = await waitFor(() => notification(harness.messages, "gateway.error"));
	assert.deepEqual(error.params, {
		code: "internal_error",
		message: "Session persistence failed.",
		method: "approval.respond",
	});
	await harness.gateway.close();
});

test("approval resolution excludes normal turns and session transitions", async () => {
	const harness = gatewayHarness({ sessions: { initialPendingApproval: true } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("approval.respond", {
		decision_id: "decision-session-node",
		choice: "reject",
		generation: 1,
	});

	const submitted = await harness.send("turn.submit", {
		message: "must wait",
		client_turn_id: "new-client",
		client_user_message_id: "new-user",
	});
	const resumed = await harness.send("session.resume", { session_id: "target" });
	assert.equal("error" in submitted ? submitted.error.code : null, "turn_in_progress");
	assert.equal("error" in resumed ? resumed.error.code : null, "turn_in_progress");

	harness.releaseTurn();
	await harness.gateway.close();
});

test("failed session preparation keeps the source active and emits no target state", async () => {
	const harness = gatewayHarness({ sessions: { targetFailure: "session_state_invalid" } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	const response = await harness.send("session.resume", { session_id: "target" });

	assert.equal("error" in response ? response.error.code : null, "session_state_invalid");
	assert.equal(harness.sessionCoordinator?.snapshot().sessionId, "session-node");
	assert.equal(notificationForSession(harness.messages, "session.changed", "target"), undefined);
	await harness.gateway.close();
});

test("read-only session replay rejects turn submission", async () => {
	const harness = gatewayHarness({ sessions: { targetReadOnly: true } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const resumed = await harness.send("session.resume", { session_id: "target" });
	assert.equal("result" in resumed ? resumed.result.read_only : false, true);

	const submitted = await harness.send("turn.submit", {
		message: "must not run",
		client_turn_id: "read-only-turn",
		client_user_message_id: "read-only-message",
		local_images: [],
	});

	assert.equal("error" in submitted ? submitted.error.code : null, "session_state_invalid");
	assert.deepEqual(harness.submissions, []);
	await harness.gateway.close();
});

test("status projects rejected steers as deferred follow-up input", async () => {
	const harness = gatewayHarness({ sessions: { targetQueue: populatedQueue("target") } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("session.resume", { session_id: "target" });
	const status = await waitFor(() => notificationForSession(
		harness.messages,
		"status.changed",
		"target",
	));

	assert.deepEqual(status.params.queued_steering, ["steer now"]);
	assert.deepEqual(status.params.queued_follow_up, ["deferred steer", "follow later"]);
	assert.deepEqual(status.params.queue_activity, {
		kind: "pending_input",
		has_pending_input: true,
		steering_count: 1,
		follow_up_count: 2,
	});
	assert.deepEqual(
		status.params.queue_items.rejected_steers.map((item: { queue_id: string }) => item.queue_id),
		["queue-rejected"],
	);
	await harness.gateway.close();
});

test("queue RPCs persist before publication and deduplicate lost responses", async () => {
	const harness = gatewayHarness({ queue: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "inspect",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});

	const first = await harness.send("turn.steer", {
		message: "also inspect package.json",
		client_user_message_id: "steer-message-1",
		expected_turn_id: "turn-node",
		local_images: [{ path: "/tmp/context.png", placeholder: "[image #1]" }],
	});
	const updated = await waitFor(() => notification(harness.messages, "turn.queue.updated"));

	assert.equal("result" in first ? first.result.disposition : null, "accepted_for_turn");
	assert.equal("result" in first ? first.result.queue_revision : null, 1);
	assert.equal("result" in first ? first.result.record.queue_id : null, "queue-1");
	assert.deepEqual(harness.queue?.persistedRevisions, [1]);
	assert.equal(updated.params.queue_revision, 1);
	assert.deepEqual(updated.params.steering, ["also inspect package.json"]);
	assert.equal(updated.params.queue_items.pending_steers[0].local_images[0].path, "/tmp/context.png");
	parseGatewayEvent(updated);
	const responseIndex = harness.messages.indexOf(first);
	assert.ok(harness.messages.indexOf(updated) < responseIndex);

	const eventCount = notificationCount(harness.messages, "turn.queue.updated");
	const duplicate = await harness.send("turn.steer", {
		message: "also inspect package.json",
		client_user_message_id: "steer-message-1",
		expected_turn_id: "turn-node",
		local_images: [{ path: "/tmp/context.png", placeholder: "[image #1]" }],
	});

	assert.equal("result" in duplicate ? duplicate.result.disposition : null, "duplicate");
	assert.equal("result" in duplicate ? duplicate.result.record.queue_id : null, "queue-1");
	assert.equal("result" in duplicate ? duplicate.result.queue_revision : null, 1);
	assert.deepEqual(harness.queue?.persistedRevisions, [1]);
	assert.equal(notificationCount(harness.messages, "turn.queue.updated"), eventCount);
	harness.releaseTurn();
	await harness.gateway.close();
});

test("stale steers are durably deferred instead of losing user input", async () => {
	const harness = gatewayHarness({ queue: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "inspect",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});

	const response = await harness.send("turn.steer", {
		message: "use a newer turn",
		client_turn_id: "stale-steer",
		expected_turn_id: "turn-old",
	});

	assert.equal("result" in response ? response.result.disposition : null, "deferred_to_end_of_turn");
	assert.equal("result" in response ? response.result.record.kind : null, "rejected_steer");
	assert.deepEqual(
		harness.queue?.coordinator.snapshot().rejectedSteers.map((item) => item.text),
		["use a newer turn"],
	);
	harness.releaseTurn();
	await waitFor(() => harness.submissions.length >= 2);
	const started = await waitFor(() => notifications(harness.messages, "item.started")
		.find((message) => message.params.item.client_user_message_id === "stale-steer"));
	const completed = await waitFor(() => notifications(harness.messages, "item.completed")
		.find((message) => message.params.item.client_user_message_id === "stale-steer"));
	assert.deepEqual(started.params, {
		client_turn_id: "stale-steer",
		turn_id: "turn-node",
		item: {
			id: "turn-node:user:stale-steer",
			type: "user_message",
			client_user_message_id: "stale-steer",
			content: "use a newer turn",
			source: "steer",
		},
	});
	assert.deepEqual(completed.params, started.params);
	await harness.gateway.close();
});

test("follow-up input racing terminal completion remains durably queued", async () => {
	const harness = gatewayHarness({ queue: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "inspect",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});

	const followUp = harness.send("turn.follow_up", {
		message: "summarize afterward",
		client_turn_id: "follow-up-1",
	});
	harness.releaseTurn();
	const response = await followUp;
	await waitFor(() => notification(harness.messages, "turn.completed"));
	await waitFor(() => harness.submissions.length >= 2);

	assert.equal("result" in response ? response.result.disposition : null, "queued_follow_up");
	assert.equal(harness.queue?.persistedRevisions.includes(1), true);
	assert.equal(harness.submissions[1]?.message, "summarize afterward");
	await harness.gateway.close();
});

test("reserves one queued next turn before removing its queue record", async () => {
	const harness = gatewayHarness({ queue: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "first turn",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	await harness.send("turn.follow_up", {
		message: "queued next turn",
		client_turn_id: "queued-client-id",
	});

	harness.releaseTurn();
	await waitFor(() => harness.submissions.length >= 2);

	assert.deepEqual(harness.reservedClientTurnIds, ["client-turn", "queued-client-id"]);
	assert.deepEqual(harness.submissions[1], {
		clientTurnId: "queued-client-id",
		clientUserMessageId: "queued-client-id",
		turnId: "turn-node",
		message: "queued next turn",
		localImages: [],
		modelOverride: "gpt-test",
	});
	assert.equal(harness.queue?.coordinator.snapshot().followUps.length, 0);
	const started = await waitFor(() => notifications(harness.messages, "item.started")
		.find((message) => message.params.item.client_user_message_id === "queued-client-id"));
	const completed = await waitFor(() => notifications(harness.messages, "item.completed")
		.find((message) => message.params.item.client_user_message_id === "queued-client-id"));
	assert.deepEqual(started.params, {
		client_turn_id: "queued-client-id",
		turn_id: "turn-node",
		item: {
			id: "turn-node:user:queued-client-id",
			type: "user_message",
			client_user_message_id: "queued-client-id",
			content: "queued next turn",
			source: "submit",
		},
	});
	assert.deepEqual(completed.params, started.params);
	await harness.gateway.close();
});

test("retains queued input when the next-turn reservation fails", async () => {
	const harness = gatewayHarness({
		queue: {},
		reserve: (submission) => {
			if (submission.clientTurnId === "queued-client-id") {
				throw new StorageFailure("private reservation failure");
			}
			return { kind: "reserved", turn: turnRecord(submission, "in_progress") };
		},
	});
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "first turn",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	await harness.send("turn.follow_up", {
		message: "keep queued",
		client_turn_id: "queued-client-id",
	});

	harness.releaseTurn();
	await waitFor(() => harness.reservedClientTurnIds.includes("queued-client-id"));
	const failure = await waitFor(() => notification(harness.messages, "gateway.error"));

	assert.deepEqual(
		harness.queue?.coordinator.snapshot().followUps.map((item) => item.text),
		["keep queued"],
	);
	assert.equal(failure.params.code, "queue_worker_start_failed");
	assert.equal(JSON.stringify(failure).includes("private reservation failure"), false);
	await harness.gateway.close();
});

test("queue pop, clear, and legacy migration ack return durable revisions", async () => {
	const harness = gatewayHarness({ queue: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.follow_up", { message: "first", client_turn_id: "follow-1" });
	await harness.send("turn.follow_up", { message: "second", client_turn_id: "follow-2" });

	const popped = await harness.send("turn.queue.pop");
	assert.equal("result" in popped ? popped.result.item.text : null, "second");
	assert.equal("result" in popped ? popped.result.queue_revision : null, 3);
	const cleared = await harness.send("turn.queue.clear");
	assert.deepEqual("result" in cleared ? cleared.result.follow_up : null, ["first"]);
	assert.equal(harness.queue?.coordinator.snapshot().followUps.length, 0);

	await harness.send("turn.follow_up", { message: "legacy", client_turn_id: "legacy-1" });
	const bootstrap = await harness.send("session.bootstrap", { protocol_version: 1 });
	const migration = "result" in bootstrap ? bootstrap.result.legacy_user_queue_migration : undefined;
	assert.equal(migration.records[0].text, "legacy");
	const acknowledged = await harness.send("turn.queue.migration.ack", { token: migration.token });
	assert.equal("result" in acknowledged ? acknowledged.result.acknowledged : false, true);
	assert.equal(harness.queue?.coordinator.snapshot().followUps.length, 0);
	await harness.gateway.close();
});

test("queue storage failures return sanitized errors without publishing", async () => {
	const harness = gatewayHarness({ queue: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	if (harness.queue) harness.queue.failSave = true;
	const before = notificationCount(harness.messages, "turn.queue.updated");

	const response = await harness.send("turn.follow_up", {
		message: "must persist",
		client_turn_id: "follow-secret",
	});

	assert.deepEqual("error" in response ? response.error : null, {
		code: "persistence_error",
		message: "Session persistence failed.",
	});
	assert.equal(notificationCount(harness.messages, "turn.queue.updated"), before);
	assert.equal(JSON.stringify(harness.messages).includes("private sqlite path"), false);
	await harness.gateway.close();
});

test("turn submission cannot reserve the source while target preparation is pending", async () => {
	let preparationStarted!: () => void;
	let releasePreparation!: () => void;
	const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
	const released = new Promise<void>((resolve) => { releasePreparation = resolve; });
	const harness = gatewayHarness({
		sessions: {
			prepareTarget: async () => {
				preparationStarted();
				await released;
			},
		},
	});
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const resume = harness.send("session.resume", { session_id: "target" });
	await started;

	const submitted = await harness.send("turn.submit", {
		message: "must not reserve source",
		client_turn_id: "racing-turn",
		client_user_message_id: "racing-message",
		local_images: [],
	});
	releasePreparation();
	const resumed = await resume;
	if ("result" in submitted) harness.releaseTurn();

	assert.equal(
		"error" in submitted ? submitted.error.code : null,
		"turn_in_progress",
		JSON.stringify(submitted),
	);
	assert.ok("result" in resumed);
	assert.deepEqual(harness.submissions, []);
	await harness.gateway.close();
});

test("session resume rejects an executing turn and ignores stale generation callbacks", async () => {
	const harness = gatewayHarness({ sessions: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "hello",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	const blocked = await harness.send("session.resume", { session_id: "target" });
	assert.equal("error" in blocked ? blocked.error.code : null, "turn_in_progress");
	assert.equal(harness.sessionCoordinator?.snapshot().sessionId, "session-node");

	harness.releaseTurn();
	await waitFor(() => notification(harness.messages, "turn.completed"));
	await harness.send("session.resume", { session_id: "target" });
	const before = notificationCount(harness.messages, "message.delta");
	harness.emit({ type: "text_delta", text: "late source event" });
	await new Promise<void>((resolve) => { setImmediate(resolve); });
	assert.equal(notificationCount(harness.messages, "message.delta"), before);
	await harness.gateway.close();
});

test("turn submission publishes the committed user item lifecycle", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	const response = await harness.send("turn.submit", {
		message: "hello",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	const started = await waitFor(() => notification(harness.messages, "item.started"));
	const completed = await waitFor(() => notification(harness.messages, "item.completed"));
	const mirrors = notifications(harness.messages, "runtime.event").filter(
		(message) => message.params.type === "item.started" || message.params.type === "item.completed",
	);

	assert.ok("result" in response, JSON.stringify(response));
	assert.deepEqual(started.params, {
		client_turn_id: "client-turn",
		turn_id: "turn-node",
		item: {
			id: "turn-node:user:client-message",
			type: "user_message",
			client_user_message_id: "client-message",
			content: "hello",
			source: "submit",
		},
	});
	assert.deepEqual(completed.params, started.params);
	assert.equal(mirrors.length, 2);
	assert.deepEqual(mirrors.map((message) => message.params.type), [
		"item.started",
		"item.completed",
	]);
	assert.deepEqual(mirrors.map((message) => message.params.payload), [
		started.params,
		completed.params,
	]);
	assert.ok(harness.messages.indexOf(started) < harness.messages.indexOf(completed));
	parseGatewayEvent(started);
	parseGatewayEvent(completed);
	for (const mirror of mirrors) parseGatewayEvent(mirror);

	harness.releaseTurn();
	await harness.gateway.close();
});

test("gateway projects committed steering user item lifecycle", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "inspect",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	const lifecycle = {
		clientTurnId: "client-turn",
		turnId: "turn-node",
		itemId: "turn-node:queue:queue-1",
		clientUserMessageId: "steer-message",
		content: "also inspect package.json",
		source: "steer" as const,
	};
	harness.emit({ type: "user_message_started", ...lifecycle });
	harness.emit({ type: "user_message_completed", ...lifecycle });

	const started = await waitFor(() => notifications(harness.messages, "item.started")
		.find((message) => message.params.item.id === lifecycle.itemId));
	const completed = await waitFor(() => notifications(harness.messages, "item.completed")
		.find((message) => message.params.item.id === lifecycle.itemId));
	const mirrors = notifications(harness.messages, "runtime.event").filter(
		(message) => message.params.payload?.item?.id === lifecycle.itemId,
	);

	assert.deepEqual(started.params, {
		client_turn_id: "client-turn",
		turn_id: "turn-node",
		item: {
			id: "turn-node:queue:queue-1",
			type: "user_message",
			client_user_message_id: "steer-message",
			content: "also inspect package.json",
			source: "steer",
		},
	});
	assert.deepEqual(completed.params, started.params);
	assert.deepEqual(mirrors.map((message) => message.params.type), [
		"item.started",
		"item.completed",
	]);

	harness.releaseTurn();
	await harness.gateway.close();
});

test("failed turn reservation publishes no user item lifecycle", async () => {
	const harness = gatewayHarness({
		reserve: () => {
			throw new StorageFailure("private sqlite path");
		},
	});
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	const response = await harness.send("turn.submit", {
		message: "must stay invisible",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});

	assert.equal("error" in response ? response.error.code : null, "persistence_error");
	assert.equal(notificationCount(harness.messages, "item.started"), 0);
	assert.equal(notificationCount(harness.messages, "item.completed"), 0);
	assert.equal(
		notifications(harness.messages, "runtime.event").filter(
			(message) => message.params.type === "item.started" || message.params.type === "item.completed",
		).length,
		0,
	);
	await harness.gateway.close();
});

test("turn submission responds immediately and emits validated direct events before mirrors", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const response = await harness.send("turn.submit", {
		message: "hello",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	assert.deepEqual("result" in response ? response.result : null, {
		accepted: true,
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		turn_id: "turn-node",
	});
	assert.deepEqual(harness.submissions, [{
		clientTurnId: "client-turn",
		clientUserMessageId: "client-message",
		turnId: "turn-node",
		message: "hello",
		localImages: [],
		modelOverride: "gpt-test",
	}]);

	harness.emit({ type: "turn_started", clientTurnId: "client-turn", turnId: "turn-node" });
	const direct = await waitFor(() => notification(harness.messages, "turn.started"));
	const mirror = await waitFor(() => notifications(harness.messages, "runtime.event")
		.find((message) => message.params.type === "turn.started"));
	parseGatewayEvent(direct);
	parseGatewayEvent(mirror);
	assert.ok(harness.messages.indexOf(direct) < harness.messages.indexOf(mirror));
	assert.deepEqual(mirror.params, {
		version: 1,
		sequence: 3,
		type: "turn.started",
		payload: direct.params,
		timestamp: 1_700_000_000,
	});
	harness.emit({ type: "text_delta", text: "hello" });
	const compatibility = await waitFor(() => notification(harness.messages, "turn.event"));
	parseGatewayEvent(compatibility);
	assert.equal(compatibility.params.kind, "text_delta");

	harness.releaseTurn();
	await harness.gateway.close();
});

test("projects bounded tool and mutation lifecycle events without sensitive fields", async () => {
	const harness = gatewayHarness();
	const fileContents = "private file contents";
	const privateHash = `sha256:${"f".repeat(64)}`;
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "read README",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	harness.emit({
		type: "tool_execution_started",
		callId: "call-1",
		toolName: "Edit",
	});
	harness.emit({
		type: "tool_execution_completed",
		callId: "call-1",
		toolName: "Edit",
		summary: "Edited src/a.ts",
		durationMs: 125,
		metadata: {
			path: "src/a.ts",
			status: "edited",
			matches: 1,
			diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n",
			addedLines: 1,
			removedLines: 1,
			diffTruncated: false,
			content: fileContents,
			sha256: privateHash,
			argumentsJson: "{\"content\":\"private\"}",
		},
	});
	harness.emit({
		type: "tool_execution_failed",
		callId: "call-2",
		toolName: "Edit",
		summary: "Failed to edit missing.txt",
		durationMs: 5,
		errorKind: "not_found",
		metadata: {
			path: "missing.txt",
			errorKind: "not_found",
			content: fileContents,
			sha256: privateHash,
			argumentsJson: "{\"file_path\":\"private\"}",
		},
	});
	await new Promise<void>((resolve) => { setImmediate(resolve); });

	const direct = harness.messages.filter((message) =>
		"method" in message
		&& !("id" in message)
		&& ["tool.start", "tool.complete", "tool.failed"].includes(message.method),
	);
	assert.deepEqual(direct.map((message) => "method" in message ? message.method : ""), [
		"tool.start",
		"tool.complete",
		"tool.failed",
	]);
	assert.deepEqual(direct.map((message) => "method" in message ? message.params.tool_id : ""), [
		"call-1",
		"call-1",
		"call-2",
	]);
	for (const message of direct) parseGatewayEvent(message);
	const turnEvents = harness.messages.filter((message) =>
		"method" in message && !("id" in message) && message.method === "turn.event",
	);
	assert.deepEqual(turnEvents.map((message) => message.params.kind), [
		"tool_start",
		"tool_complete",
		"tool_failed",
	]);
	assert.equal(turnEvents[0]?.params.tool_name, "Edit");
	assert.equal(turnEvents[0]?.params.metadata.call_id, "call-1");
	const complete = direct[1]!;
	assert.equal("method" in complete ? complete.params.path : undefined, "src/a.ts");
	assert.equal("method" in complete ? complete.params.status : undefined, "edited");
	assert.equal("method" in complete ? complete.params.matches : undefined, 1);
	assert.deepEqual("method" in complete ? complete.params.file_changes : undefined, [{
		version: 1,
		kind: "update",
		path: "src/a.ts",
		diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n",
		added_lines: 1,
		removed_lines: 1,
	}]);
	const failed = direct[2]!;
	assert.equal("method" in failed ? failed.params.path : undefined, "missing.txt");
	assert.equal("method" in failed ? failed.params.error_kind : undefined, "not_found");
	assert.deepEqual(turnEvents[1]?.params.metadata, {
		call_id: "call-1",
		duration_ms: 125,
		success: true,
		path: "src/a.ts",
		status: "edited",
		matches: 1,
		file_changes: [{
			version: 1,
			kind: "update",
			path: "src/a.ts",
			diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n",
			added_lines: 1,
			removed_lines: 1,
		}],
	});
	assert.deepEqual(turnEvents[2]?.params.metadata, {
		call_id: "call-2",
		duration_ms: 5,
		success: false,
		path: "missing.txt",
		error_kind: "not_found",
	});
	const serialized = JSON.stringify([...direct, ...turnEvents]);
	assert.equal(serialized.includes(fileContents), false);
	assert.equal(serialized.includes(privateHash), false);
	assert.equal(serialized.includes("argumentsJson"), false);

	harness.releaseTurn();
	await harness.gateway.close();
});

test("projects structured plan updates with Codex explanation and task counts", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "plan the work",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	harness.emit({
		type: "plan_updated",
		explanation: "Start implementation",
		items: [
			{ id: "step-1", text: "Inspect runtime", status: "completed" },
			{ id: "step-2", text: "Wire plan updates", status: "in_progress" },
		],
	});

	const direct = await waitFor(() => notification(harness.messages, "plan.updated"));
	parseGatewayEvent(direct);
	assert.deepEqual(direct.params, {
		client_turn_id: "client-turn",
		plan_steps: ["completed: Inspect runtime", "in_progress: Wire plan updates"],
		plan: {
			items: [
				{ id: "step-1", text: "Inspect runtime", status: "completed" },
				{ id: "step-2", text: "Wire plan updates", status: "in_progress" },
			],
		},
		source: "update_plan",
		completed: 1,
		total: 2,
		explanation: "Start implementation",
	});
	const mirror = await waitFor(() => notifications(harness.messages, "runtime.event")
		.find((message) => message.params.type === "plan.updated"));
	parseGatewayEvent(mirror);
	assert.deepEqual(mirror.params.payload, direct.params);

	harness.releaseTurn();
	await harness.gateway.close();
});

test("projects compaction lifecycle events with the canonical bounded payload", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "continue",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	harness.emit({
		type: "compaction_started",
		clientTurnId: "client-turn",
		source: "pre_turn",
		beforeTokens: 95_000,
		maxTokens: 100_000,
	});
	harness.emit({
		type: "compaction_completed",
		clientTurnId: "client-turn",
		source: "pre_turn",
		status: "compressed",
		beforeTokens: 95_000,
		afterTokens: 12_000,
		maxTokens: 100_000,
		durationSeconds: 0.25,
	});
	await new Promise<void>((resolve) => { setImmediate(resolve); });

	const direct = harness.messages.filter((message) =>
		"method" in message
		&& !("id" in message)
		&& ["compaction.started", "compaction.completed"].includes(message.method),
	);
	assert.deepEqual(direct.map((message) => "method" in message ? message.method : ""), [
		"compaction.started",
		"compaction.completed",
	]);
	assert.deepEqual("method" in direct[0]! ? direct[0].params : {}, {
		client_turn_id: "client-turn",
		source: "pre_turn",
		before_tokens: 95_000,
		max_tokens: 100_000,
	});
	assert.deepEqual("method" in direct[1]! ? direct[1].params : {}, {
		client_turn_id: "client-turn",
		source: "pre_turn",
		status: "compressed",
		before_tokens: 95_000,
		after_tokens: 12_000,
		max_tokens: 100_000,
		duration_s: 0.25,
	});
	for (const message of direct) parseGatewayEvent(message);
	harness.releaseTurn();
	await harness.gateway.close();
});

test("turn submission rejects a conflicting client turn id before accepting it", async () => {
	const harness = gatewayHarness({
		existingTurn: {
			schema_version: 1,
			session_id: "session-node",
			client_turn_id: "client-turn",
			turn_id: "existing-turn",
			request_fingerprint: fingerprintSubmission({ message: "original", localImages: [] }),
			status: "completed",
			error_code: null,
			result: { assistant_text: "done", usage: {} },
			started_at: "2026-08-04T00:00:00.000Z",
			completed_at: "2026-08-04T00:00:01.000Z",
		},
	});
	try {
		const response = await harness.send("turn.submit", {
			message: "different",
			client_turn_id: "client-turn",
			client_user_message_id: "client-message",
			local_images: [],
		});
		assert.ok("error" in response);
		assert.equal("error" in response ? response.error.code : null, "message_id_conflict");
		assert.equal(harness.submissions.length, 0);
	} finally {
		harness.releaseTurn();
		await harness.gateway.close();
	}
});

test("two gateways atomically reject a conflicting concurrent client turn id", async () => {
	let reserved: RuntimeTurnRecord | undefined;
	const reserve = (submission: TurnSubmission) => {
		const fingerprint = fingerprintSubmission({
			message: submission.message,
			localImages: submission.localImages,
		});
		if (!reserved) {
			reserved = { ...turnRecord(submission, "in_progress"), request_fingerprint: fingerprint };
			return { kind: "reserved" as const, turn: reserved };
		}
		if (reserved.request_fingerprint !== fingerprint) {
			throw Object.assign(new Error("conflicting payload"), { code: "message_id_conflict" });
		}
		return { kind: "existing" as const, turn: reserved };
	};
	const first = gatewayHarness({ reserve });
	const second = gatewayHarness({ reserve });
	try {
		const [firstResponse, secondResponse] = await Promise.all([
			first.send("turn.submit", {
				message: "first",
				client_turn_id: "shared-client-turn",
				client_user_message_id: "first-message",
			}),
			second.send("turn.submit", {
				message: "second",
				client_turn_id: "shared-client-turn",
				client_user_message_id: "second-message",
			}),
		]);
		const responses = [firstResponse, secondResponse];
		assert.equal(responses.filter((response) => "result" in response).length, 1);
		const conflict = responses.find((response) => "error" in response);
		assert.equal(conflict && "error" in conflict ? conflict.error.code : null, "message_id_conflict");
		assert.equal(first.submissions.length + second.submissions.length, 1);
	} finally {
		first.releaseTurn();
		second.releaseTurn();
		await Promise.all([first.gateway.close(), second.gateway.close()]);
	}
});

test("recovered interruption publishes durable terminal state before idle status", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const start = harness.messages.length;

	harness.gateway.publishRecoveredInterrupt(turnRecord({
		clientTurnId: "client-recovered",
		turnId: "turn-recovered",
		message: "recover",
	}, "interrupted"));

	await waitFor(() => notification(harness.messages, "status.changed"));
	const methods = harness.messages.slice(start)
		.filter((message) => "method" in message && message.method !== "runtime.event")
		.map((message) => "method" in message ? message.method : "");
	assert.deepEqual(methods, [
		"turn.interrupted",
		"turn.status",
		"status.update",
		"status.changed",
	]);
	const interrupted = notification(harness.messages, "turn.interrupted");
	assert.deepEqual(interrupted?.params, {
		client_turn_id: "client-recovered",
		turn_id: "turn-recovered",
		code: "interrupted",
		requested: false,
		message: "Turn interrupted",
		input_rolled_back: false,
	});
	await harness.gateway.close();
});

test("turn interrupt aborts the active request and shutdown closes resources", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "wait",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
	});
	const interrupted = await harness.send("turn.interrupt", { turn_id: "turn-node" });
	assert.deepEqual("result" in interrupted ? interrupted.result : null, {
		accepted: true,
		requested: true,
		client_turn_id: "client-turn",
		turn_id: "turn-node",
		input_rolled_back: false,
	});
	assert.equal(harness.signal()?.aborted, true);
	const terminal = await waitFor(() => notification(harness.messages, "turn.interrupted"));
	assert.equal(terminal.params.requested, false);
	assert.equal(terminal.params.input_rolled_back, false);
	assert.equal(harness.forcedInterrupts(), 1);
	assert.ok(harness.messages.indexOf(terminal) < harness.messages.indexOf(interrupted));
	const deltaCount = notificationCount(harness.messages, "message.delta");
	harness.emit({ type: "text_delta", text: "late output" });
	harness.emit({ type: "turn_completed", assistantText: "late output", usage: {} });
	assert.equal(notificationCount(harness.messages, "message.delta"), deltaCount);
	const suppressed = await waitFor(() => notification(
		harness.messages,
		"turn.completion_suppressed",
	));
	assert.equal(suppressed.params.client_turn_id, "client-turn");
	harness.releaseTurn();
	await waitFor(() => harness.traceAppends.find((entry) => entry.event.kind === "turn_interrupted"));
	assert.deepEqual(harness.traceAppends.map((entry) => entry.event.kind), [
		"turn_interrupt_requested",
		"turn_interrupted",
	]);
	await harness.send("shutdown", {});
	await harness.gateway.completion;
	assert.equal(harness.closeCalls(), 1);
});

test("turn interrupt prefers cooperative runtime settlement inside the grace window", async () => {
	const harness = gatewayHarness({ cooperativeInterrupt: true });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "wait",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
	});

	const interrupted = await harness.send("turn.interrupt", { turn_id: "turn-node" });
	assert.equal("result" in interrupted && interrupted.result.accepted, true);
	assert.equal(harness.runtimeSettled(), true);
	assert.equal(harness.forcedInterrupts(), 0);
	assert.ok(notification(harness.messages, "turn.interrupted"));

	harness.releaseTurn();
	await harness.gateway.close();
});

test("turn interrupt confirms composer restoration only before visible agent output", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "wait",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
	});
	const interrupted = await harness.send("turn.interrupt", {
		turn_id: "turn-node",
		rollback_user_input: true,
	});
	assert.equal("result" in interrupted && interrupted.result.input_rolled_back, true);
	const terminal = await waitFor(() => notification(harness.messages, "turn.interrupted"));
	assert.equal(terminal.params.input_rolled_back, true);
	harness.releaseTurn();
	await harness.gateway.close();

	const visibleHarness = gatewayHarness();
	await waitFor(() => notification(visibleHarness.messages, "runtime.ready"));
	await visibleHarness.send("turn.submit", {
		message: "wait",
		client_turn_id: "visible-turn",
		client_user_message_id: "visible-message",
	});
	visibleHarness.emit({ type: "text_delta", text: "Working" });
	const denied = await visibleHarness.send("turn.interrupt", {
		turn_id: "turn-node",
		rollback_user_input: true,
	});
	assert.equal("result" in denied && denied.result.input_rolled_back, false);
	visibleHarness.releaseTurn();
	await visibleHarness.gateway.close();
});

test("turn interrupt rejection returns an authoritative idle status", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const response = await harness.send("turn.interrupt", { rollback_user_input: true });
	assert.equal("result" in response && response.result.accepted, false);
	assert.equal("result" in response && response.result.requested, false);
	assert.equal("result" in response && response.result.turn_running, false);
	harness.releaseTurn();
	await harness.gateway.close();
});

test("turn interrupt fences stale turn ids and returns the active id", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "wait",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
	});

	const mismatch = await harness.send("turn.interrupt", { turn_id: "stale-turn" });
	assert.equal("error" in mismatch ? mismatch.error.code : null, "turn_id_mismatch");
	assert.deepEqual("error" in mismatch ? mismatch.error.data : null, {
		actual_turn_id: "turn-node",
	});
	assert.equal(harness.signal()?.aborted, false);

	const interrupted = await harness.send("turn.interrupt", { turn_id: "turn-node" });
	assert.equal("result" in interrupted && interrupted.result.accepted, true);
	harness.releaseTurn();
	await harness.gateway.close();
});

test("shutdown waits for an aborted turn to settle before closing resources", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "wait",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
	});
	await harness.send("shutdown", {});
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(harness.closeCalls(), 0);
	harness.releaseTurn();
	await harness.gateway.completion;
	assert.equal(harness.runtimeSettled(), true);
	assert.equal(harness.closeCalls(), 1);
});

test("unsupported methods return a stable error and observable gateway event", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const response = await harness.send("missing.method", {});
	assert.ok("error" in response);
	assert.equal("error" in response ? response.error.code : null, "method_not_found");
	const event = await waitFor(() => notification(harness.messages, "gateway.error"));
	const mirror = await waitFor(() => harness.messages.find((message) =>
		"method" in message
		&& !("id" in message)
		&& message.method === "runtime.event"
		&& message.params.type === "gateway.error",
	));
	parseGatewayEvent(event);
	parseGatewayEvent(mirror);
	assert.ok(harness.messages.indexOf(event) < harness.messages.indexOf(mirror));
	assert.deepEqual(event.params, {
		code: "method_not_found",
		message: "Unknown gateway method.",
		method: "missing.method",
	});
	await harness.gateway.close();
});

function notification(messages: RpcMessage[], method: string) {
	return messages.find((message) => "method" in message && !("id" in message) && message.method === method);
}

function notificationForSession(messages: RpcMessage[], method: string, sessionId: string) {
	return messages.find((message) => "method" in message
		&& !("id" in message)
		&& message.method === method
		&& message.params.session_id === sessionId);
}

function notificationCount(messages: RpcMessage[], method: string): number {
	return messages.filter((message) => "method" in message
		&& !("id" in message)
		&& message.method === method).length;
}

function notifications(messages: RpcMessage[], method: string) {
	return messages.filter((message) => "method" in message
		&& !("id" in message)
		&& message.method === method);
}

function gatewayShellFixture() {
	const snapshots: ShellSessionSnapshot[] = [];
	const terminations: Array<{ readonly ownerSessionId: string; readonly shellId: string }> = [];
	const terminatedOwners: string[] = [];
	const listeners = new Set<(event: ShellLifecycleEvent) => void>();
	return {
		snapshots,
		terminations,
		terminatedOwners,
		manager: {
			list: (ownerSessionId: string) => snapshots.filter(
				(snapshot) => snapshot.ownerSessionId === ownerSessionId,
			),
			terminate: async (ownerSessionId: string, shellId: string) => {
				terminations.push({ ownerSessionId, shellId });
				return snapshots.find((snapshot) => snapshot.ownerSessionId === ownerSessionId
					&& snapshot.shellId === shellId) ?? shellSnapshot({
					ownerSessionId,
					shellId,
					success: false,
					status: "error",
					processState: "shell_not_found",
				});
			},
			terminateOwner: async (ownerSessionId: string) => {
				terminatedOwners.push(ownerSessionId);
				return snapshots.filter((snapshot) => snapshot.ownerSessionId === ownerSessionId
					&& snapshot.status === "running");
			},
		},
		lifecycle: {
			subscribe: (listener: (event: ShellLifecycleEvent) => void) => {
				listeners.add(listener);
				return () => { listeners.delete(listener); };
			},
		},
		publish: (event: ShellLifecycleEvent) => {
			for (const listener of listeners) listener(event);
		},
	};
}

function shellSnapshot(
	overrides: Partial<ShellSessionSnapshot> = {},
): ShellSessionSnapshot {
	return Object.freeze({
		success: true,
		shellId: "a1b2c3d4",
		ownerSessionId: "session-node",
		callId: "call-shell-1",
		background: true,
		status: "running",
		processState: "running_background",
		output: "ready\n",
		stdout: "ready\n",
		stderr: "",
		nextCursor: 6,
		outputChars: 6,
		newOutputChars: 6,
		omittedOutputChars: 0,
		stdoutChars: 6,
		stderrChars: 0,
		stdoutOmittedChars: 0,
		stderrOmittedChars: 0,
		cursorWasEvicted: false,
		transport: "pipe",
		tty: false,
		yielded: true,
		decodeReplacementCount: 0,
		commandPreview: "npm test",
		startedAt: "2026-08-05T00:00:00.000Z",
		wallTimeSeconds: 1,
		...overrides,
	});
}

function assertedShellPayload(
	shellId: string,
	generation: number,
	sessionId = "session-node",
	callId = "call-shell-1",
) {
	return {
		shell_id: shellId,
		session_id: sessionId,
		generation,
		call_id: callId,
		command_preview: "npm test",
		background: true,
		status: "running",
		process_state: "running_background",
		output: "ready\n",
		next_cursor: 6,
		output_chars: 6,
		omitted_output_chars: 0,
		transport: "pipe",
		tty: false,
		yielded: true,
		started_at: "2026-08-05T00:00:00.000Z",
	};
}

function shellLifecycle(
	overrides: Partial<ShellLifecycleEvent> = {},
): ShellLifecycleEvent {
	return Object.freeze({
		type: "shell_lifecycle",
		kind: "shell.started",
		shellId: "a1b2c3d4",
		ownerSessionId: "session-node",
		callId: "call-shell-1",
		sequence: 1,
		commandPreview: "npm test",
		background: true,
		processState: "running_background",
		transport: "pipe",
		tty: false,
		yielded: true,
		...overrides,
	});
}

function gatewaySessionCoordinator(
	runtime: NodeGatewayRuntime,
	options: {
		readonly targetFailure?: string;
		readonly targetReadOnly?: boolean;
		readonly prepareTarget?: () => Promise<void>;
		readonly targetQueue?: QueueSnapshot;
		readonly initialPendingApproval?: boolean;
		readonly targetPendingApproval?: boolean;
		readonly initialPendingClarification?: boolean;
		readonly targetPendingClarification?: boolean;
		readonly approvalOptions?: readonly PendingApprovalChoice[];
	},
): SessionCoordinator<NodeGatewayRuntime> {
	let freshSessionSequence = 0;
	return new SessionCoordinator({
		initial: preparedGatewaySession(
			"session-node",
			runtime,
			false,
			emptyQueue("session-node"),
			options.initialPendingApproval ?? false,
			options.approvalOptions,
			options.initialPendingClarification ?? false,
		),
		prepare: async (sessionId) => {
			await options.prepareTarget?.();
			if (options.targetFailure) {
				throw Object.assign(new Error("target preparation failed"), {
					code: options.targetFailure,
				});
			}
			return preparedGatewaySession(
				sessionId,
				runtime,
				options.targetReadOnly ?? false,
				options.targetQueue,
				options.targetPendingApproval ?? false,
				options.approvalOptions,
				options.targetPendingClarification ?? false,
			);
		},
		create: () => {
			freshSessionSequence += 1;
			return preparedGatewaySession(`fresh-${freshSessionSequence}`, runtime, false, emptyQueue(`fresh-${freshSessionSequence}`));
		},
		listSessions: () => [
			sessionOverview("target", "2026-08-04T00:00:01.000Z"),
			sessionOverview("session-node", "2026-08-04T00:00:00.000Z"),
		],
		loadSessionLineage: (sessionId) => sessionId === "target"
			? [
				{ sessionId: "session-node" },
				{ sessionId: "target", parentId: "session-node", forkPoint: 1 },
			]
			: [{ sessionId }],
	});
}

function preparedGatewaySession(
	sessionId: string,
	runtime: NodeGatewayRuntime,
	readOnly = false,
	queue: QueueSnapshot = emptyQueue(sessionId),
	pendingApproval = false,
	approvalOptions: readonly PendingApprovalChoice[] = ["approve_once", "reject"],
	pendingClarification = false,
): PreparedSession<NodeGatewayRuntime> {
	return {
		sessionId,
		workspaceRoot: "/repo",
		threadId: sessionId,
		transcript: [transcriptItem(sessionId)],
		queue,
		...(pendingApproval ? { pendingApproval: {
			sessionId,
			clientTurnId: `client-${sessionId}`,
			turnId: `turn-${sessionId}`,
			decisionId: `decision-${sessionId}`,
			callId: `call-${sessionId}`,
			toolName: "Write",
			preview: "Write notes.txt",
			reason: "Approval required",
			options: approvalOptions,
		} } : {}),
		...(pendingClarification ? { pendingClarification: {
			sessionId,
			clientTurnId: `client-${sessionId}`,
			clientUserMessageId: `user-${sessionId}`,
			turnId: `turn-${sessionId}`,
			requestId: `question-${sessionId}`,
			callId: `question-${sessionId}`,
			toolName: "AskUserQuestion",
			question: "Which runtime?",
			options: [{ label: "Node" }, { label: "Python" }, { label: "Other" }],
			header: "Runtime",
			multiSelect: false,
		} } : {}),
		suspendedTurn: pendingApproval || pendingClarification,
		readOnly,
		binding: runtime,
	};
}

function transcriptItem(sessionId: string): TranscriptItem {
	return { id: `${sessionId}:user:1`, type: "user_message", text: sessionId };
}

function emptyQueue(sessionId: string): QueueSnapshot {
	return Object.freeze({
		sessionId,
		revision: 0,
		pendingSteers: Object.freeze([]),
		rejectedSteers: Object.freeze([]),
		followUps: Object.freeze([]),
	});
}

function populatedQueue(sessionId: string): QueueSnapshot {
	return Object.freeze({
		sessionId,
		revision: 3,
		pendingSteers: Object.freeze([queuedInput(sessionId, "queue-pending", "pending_steer", "steer now")]),
		rejectedSteers: Object.freeze([
			queuedInput(sessionId, "queue-rejected", "rejected_steer", "deferred steer"),
		]),
		followUps: Object.freeze([queuedInput(sessionId, "queue-follow", "follow_up", "follow later")]),
	});
}

function queuedInput(
	sessionId: string,
	queueId: string,
	kind: "pending_steer" | "rejected_steer" | "follow_up",
	text: string,
) {
	return Object.freeze({
		queueId,
		sessionId,
		clientTurnId: `client-${queueId}`,
		targetTurnId: kind === "follow_up" ? null : "turn-target",
		kind,
		state: kind === "pending_steer" ? "accepted" as const : "queued" as const,
		text,
		imagePaths: Object.freeze([]),
		source: "user",
		createdAt: "2026-08-04T00:00:00.000Z",
		updatedAt: "2026-08-04T00:00:00.000Z",
	});
}

function gatewayQueueFixture(initial: QueueSnapshot) {
	let durable = initial;
	let nextQueueId = 0;
	const persistedRevisions: number[] = [];
	const fixture = {
		failSave: false,
		persistedRevisions,
		coordinator: undefined as unknown as QueueCoordinator,
	};
	const store: QueueCoordinatorStore = {
		loadCommittedQueueIds: () => new Set(),
		saveSnapshot: (snapshot) => {
			if (fixture.failSave) {
				throw new StorageFailure("private sqlite path /Users/example/.mycli/sessions.db");
			}
			durable = snapshot;
			persistedRevisions.push(snapshot.revision);
		},
		commitPending: (_turnId, records) => {
			const ids = new Set(records.map((record) => record.queueId));
			durable = Object.freeze({
				...durable,
				revision: durable.revision + 1,
				pendingSteers: Object.freeze(durable.pendingSteers.filter(
					(record) => !ids.has(record.queueId),
				)),
			});
			persistedRevisions.push(durable.revision);
			return durable;
		},
	};
	fixture.coordinator = new QueueCoordinator({
		initial,
		store,
		activeTurnId: null,
		createQueueId: () => `queue-${++nextQueueId}`,
		clock: () => "2026-08-04T00:00:00.000Z",
	});
	return fixture;
}

function sessionOverview(sessionId: string, lastActiveAt: string): SessionOverview {
	return {
		sessionId,
		workspaceRoot: "/repo",
		threadId: sessionId,
		createdAt: lastActiveAt,
		updatedAt: lastActiveAt,
		lastActiveAt,
		status: "active",
		messageCount: 1,
		summaryCount: 0,
	};
}

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 1_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("timed out waiting for gateway message");
}

function turnRecord(
	submission: TurnSubmission,
	status: "in_progress" | "completed" | "interrupted",
): RuntimeTurnRecord {
	return {
		schema_version: 1,
		session_id: "session-node",
		client_turn_id: submission.clientTurnId,
		turn_id: submission.turnId ?? "turn-node",
		request_fingerprint: fingerprintSubmission({
			message: submission.message,
			localImages: submission.localImages,
		}),
		status,
		error_code: status === "interrupted" ? "interrupted" : null,
		result: null,
		started_at: "2026-08-04T00:00:00.000Z",
		completed_at: status === "in_progress" ? null : "2026-08-04T00:00:01.000Z",
	};
}
