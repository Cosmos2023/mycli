import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
	gatewayContractCatalog,
	parseGatewayEvent,
	parseJsonRpcMessage,
} from "@mycli/contracts";
import type { WorkspaceTrustState } from "@mycli/config";
import type { RuntimeErrorCode, RuntimeTurnRecord } from "@mycli/contracts";
import {
	type QueueMutation,
	type QueueSnapshot,
	type CanonicalMessage,
	type QueuedInput,
	type RuntimeEvent,
	type ReasoningEffort,
	type ShellLifecycleEvent,
} from "@mycli/core";
import type {
	PendingSessionApproval,
	PendingSessionClarification,
	QueueCoordinator,
	ResolveApprovalInput,
	ResolveClarificationInput,
	SessionCoordinator,
	SessionGenerationContext,
	SubmitTurnOptions,
	TurnSubmission,
} from "@mycli/runtime";
import {
	projectMutationMetadata,
	sanitizeShellSnapshotPayload,
	SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS,
	StorageFailure,
} from "@mycli/storage";
import type { TranscriptItem, TurnReservation } from "@mycli/storage";
import type { PermissionProfile, ShellSessionSnapshot } from "@mycli/tools";
import type { GatewayTransport } from "mycli-shell-tui/gateway-transport";
import {
	builtinCommandNames,
	commandManifest,
	resolveSlashCommand,
	SlashCommandError,
	type SlashCommandSurface,
} from "./node-slash-command-registry.ts";
import {
	diagnosticCommandResult,
	errorCommandResult,
	listCommandResult,
	noticeCommandResult,
	preformattedCommandResult,
	statusCommandResult,
} from "./node-slash-command-results.ts";

type JsonObject = Record<string, unknown>;
type RpcId = string | number | null;

export interface NodeGatewayRuntime {
	readonly queueCoordinator?: QueueCoordinator;
	listCommandAllowances?(): readonly (readonly string[])[];
	addCommandAllowance?(pattern: string): readonly (readonly string[])[];
	removeCommandAllowance?(pattern: string): readonly (readonly string[])[];
	clearCommandAllowances?(): number;
	compact?(input: {
		readonly modelOverride?: string;
		readonly signal: AbortSignal;
	}): Promise<{
		readonly status: "compressed" | "skipped" | "not_needed" | "failed" | "interrupted";
		readonly beforeTokens: number;
		readonly afterTokens: number;
	}>;
	configureExecutionPolicy?(input: {
		readonly trust: WorkspaceTrustState;
		readonly permission: PermissionProfile;
	}): void;
	reserve(submission: TurnSubmission): TurnReservation;
	resolveApproval(
		input: ResolveApprovalInput,
		emit: (event: RuntimeEvent) => void,
		options: Pick<SubmitTurnOptions, "signal">,
	): Promise<RuntimeTurnRecord>;
	resolveClarification(
		input: ResolveClarificationInput,
		emit: (event: RuntimeEvent) => void,
		options: Pick<SubmitTurnOptions, "signal">,
	): Promise<RuntimeTurnRecord>;
	submit(
		submission: TurnSubmission,
		emit: (event: RuntimeEvent) => void,
		options: SubmitTurnOptions,
	): Promise<RuntimeTurnRecord>;
}

export interface NodeGatewayMemoryCommands {
	directory(): Promise<string>;
	scan(): Promise<readonly JsonObject[]>;
	remember(input: {
		readonly kind: "user" | "feedback" | "project" | "reference";
		readonly name: string;
		readonly description: string;
		readonly content: string;
	}): Promise<JsonObject>;
	forget(query: string): Promise<readonly JsonObject[]>;
}

export interface NodeGatewayBackgroundTaskCommands {
	list(parentSessionId: string): readonly JsonObject[];
	interrupt(parentSessionId: string, childSessionId: string): Promise<boolean>;
	interruptAll(parentSessionId: string): Promise<number>;
}

export interface NodeGatewaySessionCommands {
	fork(input: {
		readonly sourceSessionId: string;
		readonly targetSessionId: string;
		readonly forkPoint?: number;
	}): {
		readonly sourceSessionId: string;
		readonly targetSessionId: string;
		readonly forkPoint: number;
		readonly messageCount: number;
	};
	search(query: string, workspaceRoot: string): readonly {
		readonly sessionId: string;
		readonly messageIndex: number;
		readonly role: string;
		readonly snippet: string;
	}[];
	maintenance(action: "report" | "empty" | "orphans" | "vacuum", workspaceRoot: string): JsonObject;
}

export interface NodeGatewayTraceCommands {
	inspect(sessionId: string): readonly JsonObject[];
	export(sessionId: string): readonly string[];
	logs(): readonly string[];
}

export interface NodeGatewayFileHistoryCommands {
	undo(sessionId: string): Promise<{
		readonly snapshotId?: string;
		readonly restoredPaths: readonly string[];
		readonly deletedPaths: readonly string[];
		readonly error?: string;
	}>;
}

export interface NodeGatewayControlCommands {
	authProviders(): Promise<readonly JsonObject[]>;
	saveApiKey(providerId: string, apiKey: string): Promise<JsonObject>;
	models(): Promise<readonly JsonObject[]>;
	selectModel(input: JsonObject): Promise<JsonObject>;
	loadSettings(): Promise<JsonObject>;
	saveSettings(settings: JsonObject): Promise<JsonObject>;
	completePath(prefix: string): Promise<readonly JsonObject[]>;
}

export interface CreateNodeGatewayOptions {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly provider: string;
	readonly model: string;
	readonly toolNames?: readonly string[];
	readonly maxPromptTokens?: number;
	readonly runtime: NodeGatewayRuntime;
	readonly loadConversation: (sessionId: string) => readonly CanonicalMessage[];
	readonly loadTranscript?: (sessionId: string) => readonly TranscriptItem[];
	readonly loadTurnRollouts?: (sessionId: string) => readonly JsonObject[];
	readonly memoryCommands?: NodeGatewayMemoryCommands;
	readonly backgroundTaskCommands?: NodeGatewayBackgroundTaskCommands;
	readonly sessionCommands?: NodeGatewaySessionCommands;
	readonly traceCommands?: NodeGatewayTraceCommands;
	readonly fileHistoryCommands?: NodeGatewayFileHistoryCommands;
	readonly controlCommands?: NodeGatewayControlCommands;
	readonly sessionCoordinator?: SessionCoordinator<NodeGatewayRuntime>;
	readonly shellManager?: {
		list(ownerSessionId: string): readonly ShellSessionSnapshot[];
		terminate(ownerSessionId: string, shellId: string): Promise<ShellSessionSnapshot>;
		terminateOwner(ownerSessionId: string): Promise<readonly ShellSessionSnapshot[]>;
	};
	readonly shellLifecycle?: {
		subscribe(listener: (event: ShellLifecycleEvent) => void): () => void;
	};
	readonly workspaceTrust?: {
		readonly initialState: WorkspaceTrustState;
		load(workspaceRoot: string): Promise<WorkspaceTrustState>;
		save(workspaceRoot: string, state: WorkspaceTrustState): Promise<void>;
	};
	readonly integrations?: NodeGatewayIntegrations;
	readonly close: () => void | Promise<void>;
	readonly createTurnId?: () => string;
	readonly clock?: () => number;
}

export interface NodeGatewayIntegrationCommands {
	list(): readonly JsonObject[];
	run(command: string, signal: AbortSignal): Promise<JsonObject | undefined>;
}

export interface NodeGatewayIntegrations {
	readonly toolManifest?: JsonObject;
	readonly diagnostics?: readonly JsonObject[];
	listResources?(): readonly JsonObject[] | Promise<readonly JsonObject[]>;
	readonly commands?: NodeGatewayIntegrationCommands;
	subscribeSubagents?(
		listener: (subagent: Readonly<Record<string, unknown>>) => void,
	): () => void;
}

export interface NodeGateway {
	readonly transport: GatewayTransport;
	readonly completion: Promise<number>;
	close(): Promise<void>;
	kill(): void;
	diagnostic(): string;
}

interface ActiveTurn {
	readonly clientTurnId: string;
	readonly clientUserMessageId: string;
	readonly controller: AbortController;
	readonly context: SessionGenerationContext;
	readonly runtime: NodeGatewayRuntime;
	turnId?: string;
	terminalEmitted: boolean;
}

interface RpcRequest {
	readonly id: string | number;
	readonly method: string;
	readonly params: JsonObject;
}

class InProcessNodeGateway implements NodeGateway {
	readonly transport: GatewayTransport;
	readonly completion: Promise<number>;
	readonly #options: CreateNodeGatewayOptions;
	readonly #clientInput = new PassThrough();
	readonly #clientOutput = new PassThrough();
	readonly #clock: () => number;
	readonly #resolveCompletion: (code: number) => void;
	#activeTurn: ActiveTurn | null = null;
	#activeTurnTask: Promise<void> | null = null;
	#sequence = 0;
	#closed = false;
	#closePromise: Promise<void> | null = null;
	#unsubscribeQueue: (() => void) | null = null;
	#unsubscribeShell: (() => void) | null = null;
	#unsubscribeSubagents: (() => void) | null = null;
	#trustState: WorkspaceTrustState;
	#permissionProfile: PermissionProfile = "workspace";
	#provider: string;
	#model: string;
	#reasoningEffort: ReasoningEffort | undefined;
	#collaborationMode: "default" | "plan" = "default";

	constructor(options: CreateNodeGatewayOptions) {
		this.#options = options;
		this.#clock = options.clock ?? (() => Date.now() / 1000);
		this.#trustState = options.workspaceTrust?.initialState ?? "unknown";
		this.#provider = options.provider;
		this.#model = options.model;
		this.#configureExecutionPolicy();
		let resolveCompletion!: (code: number) => void;
		this.completion = new Promise<number>((resolve) => { resolveCompletion = resolve; });
		this.#resolveCompletion = resolveCompletion;
		this.transport = {
			input: this.#clientInput,
			output: this.#clientOutput,
			close: () => this.close(),
		};
		const lines = createInterface({ input: this.#clientOutput, crlfDelay: Infinity });
		lines.on("line", (line) => { this.#handleLine(line); });
		lines.on("error", () => { void this.close(); });
		this.#clientOutput.on("error", () => { void this.close(); });
		this.#bindQueue();
		this.#bindShellLifecycle();
		this.#bindSubagents();
		this.#emitDirect("runtime.ready", { session_id: this.#sessionId() });
	}

	close(): Promise<void> {
		this.#closePromise ??= (async () => {
			if (this.#closed) return;
			this.#closed = true;
			this.#unsubscribeQueue?.();
			this.#unsubscribeQueue = null;
			this.#unsubscribeShell?.();
			this.#unsubscribeShell = null;
			this.#unsubscribeSubagents?.();
			this.#unsubscribeSubagents = null;
			this.#activeTurn?.controller.abort();
			let exitCode = 0;
			try {
				await this.#activeTurnTask;
				await this.#options.close();
			} catch {
				exitCode = 1;
			} finally {
				this.#clientInput.end();
				this.#clientOutput.end();
				this.#resolveCompletion(exitCode);
			}
		})();
		return this.#closePromise;
	}

	kill(): void {
		void this.close();
	}

	diagnostic(): string {
		return "";
	}

	#handleLine(line: string): void {
		if (this.#closed) return;
		let request: RpcRequest;
		try {
			const parsed = parseJsonRpcMessage(JSON.parse(line) as unknown);
			if (!("id" in parsed) || !("method" in parsed) || typeof parsed.method !== "string") {
				return;
			}
			request = {
				id: parsed.id as string | number,
				method: parsed.method,
				params: isObject(parsed.params) ? parsed.params : {},
			};
		} catch {
			this.#writeError(null, "invalid_params", "Invalid JSON-RPC request.");
			return;
		}
		try {
			const result = this.#handleRequest(request);
			if (result instanceof Promise) {
				void result.then(
					(value) => { this.#completeRequest(request, value); },
					(error: unknown) => { this.#failRequest(request, error); },
				);
			} else {
				this.#completeRequest(request, result);
			}
		} catch (error) {
			this.#failRequest(request, error);
		}
	}

	#handleRequest(request: RpcRequest): JsonObject | Promise<JsonObject> {
		switch (request.method) {
			case "initialize":
				return this.#bootstrap(
					{ protocol_version: request.params.protocol_version ?? 1 },
					false,
				);
			case "status.get":
			case "status.inspect":
				return this.#status();
			case "workspace.trust.status":
				return this.#trustStatus();
			case "workspace.trust.set":
				return this.#setWorkspaceTrust(request.params);
			case "permissions.list":
				return this.#permissions();
			case "permissions.update":
				return this.#updatePermissions(request.params);
			case "extension.manifest":
				return extensionManifest(
					this.#options.toolNames ?? [],
					this.#options.integrations?.toolManifest,
				);
			case "resource.list":
				return this.#resourceList();
			case "session.bootstrap":
				return this.#bootstrap(request.params, true);
			case "transcript.load":
				return this.#transcript(request.params);
			case "command.list":
				return this.#commandList(request.params);
			case "command.run":
				return this.#commandRun(request.params);
			case "completion.slash":
				return this.#completeSlash(request.params);
			case "completion.path":
				return this.#completePath(request.params);
			case "auth.api_key.save":
				return this.#saveApiKey(request.params);
			case "model.list":
				return this.#modelList();
			case "model.select":
				return this.#selectModel(request.params);
			case "settings.load":
				return this.#loadSettings();
			case "settings.save":
				return this.#saveSettings(request.params);
			case "trace.export":
				return this.#traceExport(request.params);
			case "session.list":
				return this.#sessionList();
			case "session.resume":
				return this.#sessionResume(request.params);
			case "session.tree":
				return this.#sessionTree(request.params);
			case "shell.list":
				return this.#shellList();
			case "shell.stop":
				return this.#shellStop(request.params);
			case "shell.stop_all":
				return this.#shellStopAll();
			case "turn.submit":
				return this.#submit(request.params);
			case "approval.respond":
			case "decision.resolve":
				return this.#approvalRespond(request.params);
			case "clarify.respond":
				return this.#clarificationRespond(request.params);
			case "turn.steer":
				return this.#steer(request.params);
			case "turn.follow_up":
				return this.#followUp(request.params);
			case "turn.queue.pop":
				return this.#queuePop();
			case "turn.queue.clear":
				return this.#queueClear();
			case "turn.queue.migration.ack":
				return this.#queueMigrationAck(request.params);
			case "turn.interrupt":
				return this.#interrupt();
			case "shutdown":
				return { ok: true };
			default:
				throw new GatewayFailure("method_not_found", "Unknown gateway method.");
		}
	}

	#completeRequest(request: RpcRequest, result: JsonObject): void {
		this.#writeResult(request.id, result);
		if (request.method === "shutdown") {
			queueMicrotask(() => { void this.close(); });
		}
	}

	#failRequest(request: RpcRequest, error: unknown): void {
		const failure = gatewayFailure(error);
		this.#writeError(request.id, failure.code, failure.message);
		this.#emitRuntime("gateway.error", {
			code: failure.code === "persistence_error" ? "internal_error" : failure.code,
			message: failure.message,
			method: request.method,
		});
	}

	async #bootstrap(params: JsonObject, reemitPendingState: boolean): Promise<JsonObject> {
		if (params.protocol_version !== 1) {
			throw new GatewayFailure("incompatible_protocol", "Unsupported gateway protocol version.");
		}
		const [authProviders, models] = await Promise.all([
			this.#authProviders(),
			this.#models(),
		]);
		const payload: JsonObject = {
			protocol_version: 1,
			session_id: this.#sessionId(),
			workspace: this.#workspaceRoot(),
			provider: this.#provider,
			model: this.#model,
			status: this.#status(),
			background_shells: this.#activeShells().map((snapshot) =>
				shellSnapshotPayload(snapshot, this.#sessionContext())),
			auth_providers: authProviders,
			models,
			permissions: this.#permissions(),
			welcome: {
				startup_mark: { text: "mycli" },
				workspace: this.#workspaceRoot(),
			},
		};
		const migration = this.#queueCoordinator()?.legacyMigration();
		if (migration) payload.legacy_user_queue_migration = {
			token: migration.token,
			records: migration.records.map(legacyMigrationRecord),
		};
		const session = this.#options.sessionCoordinator?.snapshot();
		if (reemitPendingState && session?.pendingApproval) {
			this.#emitRuntime(
				"approval.request",
				approvalRequest(session.pendingApproval, session.generation),
			);
		}
		if (reemitPendingState && session?.pendingClarification) {
			this.#emitRuntime(
				"clarify.request",
				clarificationRequest(session.pendingClarification, session.generation),
			);
		}
		return payload;
	}

	async #transcript(params: JsonObject): Promise<JsonObject> {
		const sessionId = optionalString(params.session_id) ?? this.#sessionId();
		if (sessionId === this.#sessionId() && this.#options.loadTranscript) {
			return paginatedTranscript(
				sessionId,
				this.#options.loadTranscript(sessionId).map(gatewayTranscriptItem),
				params,
			);
		}
		if (this.#options.sessionCoordinator) {
			const prepared = await this.#options.sessionCoordinator.inspect(sessionId);
			return paginatedTranscript(
				sessionId,
				prepared.transcript.map(gatewayTranscriptItem),
				params,
				prepared.readOnly,
			);
		}
		if (sessionId !== this.#sessionId()) {
			throw new GatewayFailure("invalid_params", "Unknown session.");
		}
		const items = this.#options.loadConversation(sessionId).map((message, index) => ({
			id: `${sessionId}:message:${index + 1}`,
			type: message.role === "user" ? "user" : "assistant_final",
			text: message.content,
			folded: false,
			metadata: {},
		}));
		return { session_id: sessionId, items, next_before: null };
	}

	#commandList(params: JsonObject): JsonObject {
		const surface = slashCommandSurface(params.surface);
		const builtInNames = builtinCommandNames();
		const integrationCommands = (this.#options.integrations?.commands?.list() ?? [])
			.filter((command) =>
				typeof command.name === "string" && !builtInNames.has(command.name.trim()));
		return {
			commands: [
				...commandManifest(surface),
				...integrationCommands,
			],
		};
	}

	#completeSlash(params: JsonObject): JsonObject {
		const prefix = optionalString(params.prefix) ?? "/";
		const surface = params.surface === undefined ? "tui" : slashCommandSurface(params.surface);
		const commands = this.#commandList({ surface }).commands;
		return {
			items: Array.isArray(commands) ? commands.flatMap((value) => {
				if (!isObject(value) || typeof value.name !== "string" || !value.name.startsWith(prefix)) {
					return [];
				}
				return [{
					value: value.name,
					description: typeof value.description === "string" ? value.description : "",
				}];
			}) : [],
		};
	}

	async #completePath(params: JsonObject): Promise<JsonObject> {
		const prefix = optionalString(params.prefix) ?? "@";
		const items = await this.#options.controlCommands?.completePath(prefix) ?? [];
		return { items };
	}

	async #saveApiKey(params: JsonObject): Promise<JsonObject> {
		const providerId = requiredString(params.provider_id, "provider_id").trim();
		const apiKey = requiredString(params.api_key, "api_key").trim();
		const commands = this.#options.controlCommands;
		if (!commands) {
			throw new GatewayFailure("internal_error", "Credential storage is unavailable.");
		}
		return commands.saveApiKey(providerId, apiKey);
	}

	async #authProviders(): Promise<readonly JsonObject[]> {
		return await this.#options.controlCommands?.authProviders() ?? [];
	}

	async #models(): Promise<readonly JsonObject[]> {
		return await this.#options.controlCommands?.models() ?? [];
	}

	async #modelList(): Promise<JsonObject> {
		return { models: await this.#models() };
	}

	async #selectModel(params: JsonObject): Promise<JsonObject> {
		if (this.#activeTurn !== null) {
			throw new GatewayFailure(
				"turn_in_progress",
				"Wait for the current turn to finish before changing models.",
			);
		}
		const effort = reasoningEffort(params.reasoning_effort);
		const selection: JsonObject = {
			provider: requiredString(params.provider, "provider").trim(),
			protocol: requiredString(params.protocol, "protocol").trim(),
			model: requiredString(params.model, "model").trim(),
			base_url: requiredString(params.base_url, "base_url").trim(),
			...(effort ? { reasoning_effort: effort } : {}),
		};
		const commands = this.#options.controlCommands;
		if (!commands) throw new GatewayFailure("internal_error", "Model selection is unavailable.");
		const selected = await commands.selectModel(selection);
		this.#provider = String(selected.provider ?? selection.provider);
		this.#model = String(selected.model ?? selection.model);
		this.#reasoningEffort = reasoningEffort(selected.reasoning_effort ?? effort);
		const status = this.#status();
		this.#emitRuntime("status.changed", status);
		return { selected, status, models: await this.#models() };
	}

	async #loadSettings(): Promise<JsonObject> {
		const settings = await this.#options.controlCommands?.loadSettings();
		return settings
			? { settings, source: "user_config" }
			: { settings: {}, source: "defaults" };
	}

	async #saveSettings(params: JsonObject): Promise<JsonObject> {
		if (!isObject(params.settings)) {
			throw new GatewayFailure("invalid_params", "settings is required.");
		}
		const commands = this.#options.controlCommands;
		if (!commands) throw new GatewayFailure("internal_error", "Settings storage is unavailable.");
		const settings = await commands.saveSettings(params.settings);
		return {
			ok: true,
			settings,
			source: "user_config",
			message: "Saved TUI settings.",
		};
	}

	#traceExport(params: JsonObject): JsonObject {
		const trace = this.#options.traceCommands;
		if (!trace) throw new GatewayFailure("internal_error", "Trace export is unavailable.");
		const tail = params.tail === undefined ? 50 : positiveInteger(params.tail);
		if (tail === undefined) throw new GatewayFailure("invalid_params", "tail must be a positive integer.");
		return {
			session_id: this.#sessionId(),
			format: "jsonl",
			rows: trace.export(this.#sessionId()).slice(-tail),
		};
	}

	async #commandRun(params: JsonObject): Promise<JsonObject> {
		const command = requiredString(params.command, "command").trim();
		const surface = slashCommandSurface(params.surface);
		let invocation;
		try {
			invocation = resolveSlashCommand({
				text: command,
				surface,
				turnRunning: this.#activeTurn !== null,
			});
		} catch (error) {
			if (!(error instanceof SlashCommandError && error.code === "unknown_command")) {
				throw error;
			}
			const integrationResult = await this.#options.integrations?.commands?.run(
				command,
				new AbortController().signal,
			);
			if (integrationResult) return integrationResult;
			throw error;
		}
		if (invocation.owner === "tui") {
			return {
				execution: "tui",
				command_id: invocation.commandId,
				client_action: invocation.clientAction ?? "",
				args: invocation.args,
				presentation: invocation.presentation,
			};
		}
		if (invocation.commandId === "ps") {
			const context = this.#sessionContext();
			const processes = this.#activeShells().map((snapshot) =>
				shellSnapshotPayload(snapshot, context));
			return shellPsCommandResult(processes);
		}
		if (invocation.commandId === "stop") {
			const stopped = await this.#shellStopAll();
			return shellStopCommandResult(stopped);
		}
		const coreResult = await this.#coreCommand(invocation);
		if (coreResult) return coreResult;
		throw new GatewayFailure("method_not_found", "Unknown command.");
	}

	async #coreCommand(invocation: ReturnType<typeof resolveSlashCommand>): Promise<JsonObject | undefined> {
		if (invocation.commandId === "status") {
			const status = this.#status();
			return statusCommandResult(invocation, [
				{ label: "Session", value: String(status.session_id ?? this.#sessionId()) },
				{ label: "Model", value: this.#options.model },
				{ label: "Provider", value: this.#options.provider },
				{ label: "Directory", value: this.#workspaceRoot() },
				{ label: "State", value: String(status.state ?? "idle") },
			]);
		}
		if (invocation.commandId === "usage") {
			const usage = aggregateUsage(this.#options.loadTurnRollouts?.(this.#sessionId()) ?? []);
			return diagnosticCommandResult(
				invocation,
				"Usage",
				Object.entries(usage).map(([key, value]) => ({
					label: humanize(key),
					value: String(value),
				})),
			);
		}
		if (invocation.commandId === "context") {
			const contextWindow = this.#status().context_window;
			const context = isObject(contextWindow) ? contextWindow : {};
			const used = typeof context.used_tokens === "number" ? context.used_tokens : 0;
			const maximum = typeof context.max_tokens === "number" ? context.max_tokens : 0;
			return diagnosticCommandResult(invocation, "Context", [
				{ label: "Used tokens", value: String(used) },
				{ label: "Max tokens", value: String(maximum) },
				{
					label: "Usage ratio",
					value: maximum > 0 ? `${Math.round(used / maximum * 100)}%` : "unknown",
				},
			]);
		}
		if (invocation.commandId === "stats") {
			const rollouts = this.#options.loadTurnRollouts?.(this.#sessionId()) ?? [];
			const transcript = this.#options.loadTranscript?.(this.#sessionId()) ?? [];
			return diagnosticCommandResult(invocation, "Runtime stats", [
				{ label: "Turns", value: String(rollouts.length) },
				{ label: "Transcript items", value: String(transcript.length) },
				{ label: "Tool calls", value: String(transcript.filter((item) => item.type === "tool").length) },
			]);
		}
		if (invocation.commandId === "tools") {
			const manifest = this.#options.integrations?.toolManifest;
			const tools = isObject(manifest) && Array.isArray(manifest.tools) ? manifest.tools : [];
			const toolRows = tools.flatMap((value, index) => {
				if (!isObject(value)) return [];
				return [{
					key: `tool:${index}`,
					label: String(value.name ?? value.id ?? "Tool"),
					values: [String(value.source ?? "runtime"), String(value.toolset ?? "")].filter(Boolean),
				}];
			});
			if (!invocation.args || invocation.args === "list") {
				return listCommandResult(invocation, "Tools", toolRows);
			}
			if (invocation.args === "sets") {
				const toolsets = isObject(manifest) && Array.isArray(manifest.toolsets)
					? manifest.toolsets
					: [];
				return listCommandResult(invocation, "Tool sets", toolsets.flatMap((value, index) => {
					if (!isObject(value)) return [];
					return [{
						key: `toolset:${index}`,
						label: String(value.id ?? "Tool set"),
						values: [`tools=${String(value.tool_count ?? 0)}`],
					}];
				}));
			}
			if (invocation.args === "hooks") {
				const diagnostics = this.#options.integrations?.diagnostics ?? [];
				const hooks = diagnostics.filter((value) =>
					String(value.source ?? value.type ?? value.kind ?? "").toLocaleLowerCase().includes("hook"));
				return listCommandResult(invocation, "Hooks", hooks.map((value, index) => ({
					key: `hook:${index}`,
					label: String(value.name ?? value.id ?? "Hook"),
					values: [String(value.source ?? "runtime")],
					status: String(value.status ?? "configured"),
					...(typeof value.detail === "string" ? { detail: value.detail } : {}),
				})));
			}
			if (invocation.args === "extensions") {
				return listCommandResult(
					invocation,
					"Extensions",
					toolRows.filter((row) => !row.values.includes("builtin")),
				);
			}
			if (invocation.args === "plugins") {
				const resources = await this.#options.integrations?.listResources?.() ?? [];
				const resourceRows = resources.filter((value) => value.type === "plugin")
					.map((value, index) => ({
						key: `plugin-resource:${index}`,
						label: String(value.name ?? value.id ?? "Plugin"),
						values: [String(value.source ?? "runtime")],
						status: String(value.status ?? "available"),
						...(typeof value.detail === "string" ? { detail: value.detail } : {}),
					}));
				const commandRows = (this.#options.integrations?.commands?.list() ?? [])
					.filter((value) => typeof value.name === "string" && value.name.startsWith("/plugin"))
					.map((value, index) => ({
						key: `plugin-command:${index}`,
						label: String(value.name),
						values: ["command"],
						...(typeof value.description === "string" ? { detail: value.description } : {}),
					}));
				return listCommandResult(invocation, "Plugins", [...resourceRows, ...commandRows]);
			}
			return errorCommandResult(
				invocation,
				"Unsupported tools action",
				"/tools [list|sets|hooks|extensions|plugins]",
			);
		}
		if (invocation.commandId === "skills") {
			const resources = await this.#options.integrations?.listResources?.() ?? [];
			return listCommandResult(invocation, "Skills", resources.flatMap((value, index) =>
				value.type === "skill" ? [{
					key: `skill:${index}`,
					label: String(value.name ?? "Skill"),
					values: [String(value.source ?? "runtime")],
					status: String(value.status ?? "available"),
					detail: typeof value.detail === "string" ? value.detail : undefined,
				}] : []));
		}
		if (invocation.commandId === "agents") {
			const resources = await this.#options.integrations?.listResources?.() ?? [];
			const action = invocation.args || "list";
			const requested = action.startsWith("inspect ") ? action.slice("inspect ".length).trim() : undefined;
			if (action !== "list" && action !== "" && !requested) {
				return errorCommandResult(invocation, "Unsupported agents action", "/agents [list|inspect <profile-id>]");
			}
			const profiles = resources.filter((value) =>
				value.type === "prompt" && (!requested || value.name === requested));
			return listCommandResult(
				invocation,
				requested ? "Agent profile" : "Agent profiles",
				profiles.map((value, index) => ({
					key: `agent:${index}`,
					label: String(value.name ?? "Agent"),
					values: [String(value.source ?? "runtime")],
					status: String(value.status ?? "available"),
					detail: typeof value.detail === "string" ? value.detail : undefined,
				})),
			);
		}
		if (invocation.commandId === "tasks") {
			const tasks = this.#options.backgroundTaskCommands;
			if (invocation.args.startsWith("agents kill ")) {
				if (!tasks) throw new GatewayFailure("method_not_found", "Background task controls are unavailable.");
				const childSessionId = invocation.args.slice("agents kill ".length).trim();
				if (!childSessionId) {
					return errorCommandResult(invocation, "Child session ID is required", "/tasks agents kill <child-session-id>");
				}
				const interrupted = await tasks.interrupt(this.#sessionId(), childSessionId);
				return noticeCommandResult(
					invocation,
					"Background agent",
					interrupted ? `interrupted=${childSessionId}` : `not_found=${childSessionId}`,
					{ extra: { interrupted } },
				);
			}
			if (invocation.args === "kill-agents") {
				if (!tasks) throw new GatewayFailure("method_not_found", "Background task controls are unavailable.");
				const interrupted = await tasks.interruptAll(this.#sessionId());
				return noticeCommandResult(invocation, "Background agents", `interrupted=${interrupted}`, {
					extra: { interrupted },
				});
			}
			if (invocation.args === "agents" || invocation.args.startsWith("agents ")) {
				const requested = invocation.args.slice("agents".length).trim();
				const records = tasks?.list(this.#sessionId()) ?? [];
				const selected = requested
					? records.filter((record) => record.childSessionId === requested)
					: records;
				return listCommandResult(invocation, "Background agents", selected.map((record, index) => ({
					key: String(record.taskId ?? `task:${index}`),
					label: String(record.childSessionId ?? "Background agent"),
					values: [String(record.profileId ?? "agent")],
					status: String(record.status ?? "unknown"),
					detail: isObject(record.payload) && typeof record.payload.progressSummary === "string"
						? record.payload.progressSummary
						: undefined,
				})));
			}
			if (!invocation.args) {
				const context = this.#sessionContext();
				return listCommandResult(invocation, "Background terminals", this.#activeShells().map((shell) => ({
					key: shell.shellId,
					label: `shell ${shell.shellId}`,
					values: [shell.commandPreview ?? "[redacted command]"],
					status: shell.processState,
					detail: `session ${context.sessionId}`,
				})));
			}
			return errorCommandResult(
				invocation,
				"Unsupported tasks action",
				"/tasks [agents [child-session-id]|kill-agents]",
			);
		}
		if (invocation.commandId === "memory") {
			const memory = this.#options.memoryCommands;
			if (!memory) throw new GatewayFailure("method_not_found", "Memory commands are unavailable.");
			const args = invocation.args;
			if (!args || args === "list") {
				return listCommandResult(invocation, "Memory", memoryRows(await memory.scan()));
			}
			if (args === "path") {
				return diagnosticCommandResult(invocation, "Memory", [{
					label: "Path",
					value: await memory.directory(),
				}]);
			}
			if (args.startsWith("search ")) {
				const query = args.slice("search ".length).trim().toLocaleLowerCase();
				if (!query) return errorCommandResult(invocation, "Search query is required", "/memory search <query>");
				const matches = (await memory.scan()).filter((item) =>
					[item.filename, item.name, item.description, item.content].some((value) =>
						typeof value === "string" && value.toLocaleLowerCase().includes(query)));
				return listCommandResult(invocation, "Memory", memoryRows(matches));
			}
			if (args.startsWith("add ")) {
				const parsed = parseMemoryAdd(args.slice("add ".length));
				const saved = await memory.remember(parsed);
				return noticeCommandResult(
					invocation,
					"Memory updated",
					`memory_saved=${String(saved.filename ?? parsed.name)}`,
					{ presentation: "transcript" },
				);
			}
			if (args.startsWith("forget ")) {
				const query = args.slice("forget ".length).trim();
				if (!query) return errorCommandResult(invocation, "Memory name is required", "/memory forget <name>");
				const removed = await memory.forget(query);
				return noticeCommandResult(
					invocation,
					"Memory updated",
					removed.length ? `memory_forgot=${removed.length}` : "memory_forget_no_match",
					{ presentation: "transcript" },
				);
			}
			return errorCommandResult(
				invocation,
				"Unsupported memory action",
				"/memory [list|path|search|add|forget]",
			);
		}
		if (invocation.commandId === "changes") {
			const transcript = this.#options.loadTranscript?.(this.#sessionId()) ?? [];
			return listCommandResult(invocation, "File changes", fileChangeRows(transcript));
		}
		if (invocation.commandId === "undo") {
			const history = this.#options.fileHistoryCommands;
			if (!history) throw new GatewayFailure("method_not_found", "File history is unavailable.");
			let result;
			try {
				result = await history.undo(this.#sessionId());
			} catch {
				return noticeCommandResult(
					invocation,
					"Undo incomplete",
					"File history is unavailable.",
					{ severity: "warning" },
				);
			}
			const changes = [
				...result.restoredPaths.map((path) => `restored ${path}`),
				...result.deletedPaths.map((path) => `deleted ${path}`),
			];
			return noticeCommandResult(
				invocation,
				result.error ? "Undo incomplete" : "Undo complete",
				result.error ?? (changes.join(", ") || "No file changes found."),
				{
					severity: result.error ? "warning" : "success",
					extra: {
						...(result.snapshotId ? { snapshot_id: result.snapshotId } : {}),
						restored_count: result.restoredPaths.length,
						deleted_count: result.deletedPaths.length,
					},
				},
			);
		}
		if (invocation.commandId === "fork") {
			const sessions = this.#options.sessionCommands;
			if (!sessions) throw new GatewayFailure("method_not_found", "Session fork is unavailable.");
			let parsed;
			try {
				parsed = parseForkArguments(invocation.args, this.#sessionId());
			} catch {
				return errorCommandResult(
					invocation,
					"Invalid fork arguments",
					"/fork [source] [new-session] [message-index]",
				);
			}
			let result;
			try {
				result = sessions.fork(parsed);
			} catch {
				return errorCommandResult(invocation, "Unable to fork session");
			}
			const resumed = await this.#sessionResume({ session_id: result.targetSessionId });
			return noticeCommandResult(
				invocation,
				"Session forked",
				`forked=${result.sourceSessionId}->${result.targetSessionId}; fork_point=${result.forkPoint}; messages=${result.messageCount}`,
				{
					extra: {
						mutated_session: true,
						session_id: resumed.session_id,
						fork_point: result.forkPoint,
						message_count: result.messageCount,
					},
				},
			);
		}
		if (invocation.commandId === "session_search") {
			if (!invocation.args) {
				return errorCommandResult(invocation, "Search query is required", "/session search <query>");
			}
			const sessions = this.#options.sessionCommands;
			if (!sessions) throw new GatewayFailure("method_not_found", "Session search is unavailable.");
			const matches = sessions.search(invocation.args, this.#workspaceRoot());
			return listCommandResult(invocation, "Session search", matches.map((match, index) => ({
				key: `search:${index}:${match.sessionId}:${match.messageIndex}`,
				label: `${match.sessionId}:${match.messageIndex}`,
				values: [match.role],
				detail: match.snippet,
			})));
		}
		if (invocation.commandId === "session_maintenance") {
			const action = sessionMaintenanceAction(invocation.args);
			if (!action) {
				return errorCommandResult(
					invocation,
					"Unsupported session maintenance action",
					"/session maintenance [--apply-empty|--apply-orphans|--apply-vacuum]",
				);
			}
			const sessions = this.#options.sessionCommands;
			if (!sessions) throw new GatewayFailure("method_not_found", "Session maintenance is unavailable.");
			const result = sessions.maintenance(action, this.#workspaceRoot());
			if (action === "report") {
				return listCommandResult(invocation, "Session maintenance", commandObjectRows(result));
			}
			return noticeCommandResult(
				invocation,
				"Session maintenance",
				commandObjectSummary(result),
			);
		}
		if (invocation.commandId === "trace") {
			const trace = this.#options.traceCommands;
			if (!trace) throw new GatewayFailure("method_not_found", "Trace commands are unavailable.");
			if (!invocation.args) {
				return listCommandResult(invocation, "Trace", trace.inspect(this.#sessionId()).map(
					(value, index) => ({
						key: `trace:${index}`,
						label: String(value.kind ?? "event"),
						values: [String(value.turnId ?? value.turn_id ?? "")].filter(Boolean),
						status: typeof value.status === "string" ? value.status : undefined,
					}),
				));
			}
			if (invocation.args === "export") {
				return preformattedCommandResult(
					invocation,
					"Trace export",
					trace.export(this.#sessionId()),
					{ presentation: "transcript" },
				);
			}
			if (invocation.args === "logs") {
				return preformattedCommandResult(invocation, "Trace logs", trace.logs());
			}
			return errorCommandResult(invocation, "Unsupported trace action", "/trace [export|logs]");
		}
		if (invocation.commandId === "help") {
			return listCommandResult(invocation, "Commands", commandManifest("cli").map((command) => ({
				key: `command:${command.id}`,
				label: command.name,
				detail: command.description,
			})));
		}
		if (invocation.commandId === "model") {
			const selection = parseModelSelection(invocation.args);
			this.#model = selection.model ?? this.#model;
			this.#reasoningEffort = selection.reasoningEffort ?? this.#reasoningEffort;
			this.#emitRuntime("status.changed", this.#status());
			return noticeCommandResult(invocation, "Model updated", [
				`model=${this.#model}`,
				...(this.#reasoningEffort ? [`thinking_effort=${this.#reasoningEffort}`] : []),
			].join("; "), {
				extra: {
					mutated_model: true,
					model: this.#model,
					...(this.#reasoningEffort ? { thinking_effort: this.#reasoningEffort } : {}),
				},
			});
		}
		if (invocation.commandId === "plan" || invocation.commandId === "mode") {
			const requested = invocation.commandId === "plan" ? "plan" : invocation.args || this.#collaborationMode;
			if (requested !== "default" && requested !== "plan") {
				return errorCommandResult(invocation, "Unsupported collaboration mode", "/mode [default|plan]");
			}
			const mutated = requested !== this.#collaborationMode || invocation.commandId === "plan";
			this.#collaborationMode = requested;
			this.#emitRuntime("status.changed", this.#status());
			return noticeCommandResult(invocation, "Collaboration mode", `collaboration_mode=${requested}`, {
				extra: {
					mutated_mode: mutated,
					collaboration_mode: requested,
				},
			});
		}
		if (invocation.commandId === "sandbox") {
			const sandbox = requestedSandboxMode(invocation.args, this.#permissionProfile);
			this.#permissionProfile = permissionForSandbox(sandbox);
			this.#configureExecutionPolicy();
			this.#emitRuntime("status.changed", this.#status());
			return noticeCommandResult(invocation, "Sandbox", `sandbox=${sandbox}`, {
				extra: { mutated_mode: Boolean(invocation.args), sandbox_mode: sandbox },
			});
		}
		if (invocation.commandId === "permissions") {
			const runtime = this.#runtime();
			let summary: string;
			let cleared: number | undefined;
			if (invocation.args.startsWith("allow ")) {
				const pattern = requiredCommandPattern(invocation.args.slice("allow ".length));
				if (!runtime.addCommandAllowance) {
					throw new GatewayFailure("method_not_found", "Command allowances are unavailable.");
				}
				runtime.addCommandAllowance(pattern);
				summary = `allowed=${pattern}`;
			} else if (invocation.args.startsWith("revoke ")) {
				const pattern = requiredCommandPattern(invocation.args.slice("revoke ".length));
				if (!runtime.removeCommandAllowance) {
					throw new GatewayFailure("method_not_found", "Command allowances are unavailable.");
				}
				runtime.removeCommandAllowance(pattern);
				summary = `revoked=${pattern}`;
			} else if (invocation.args === "clear") {
				if (!runtime.clearCommandAllowances) {
					throw new GatewayFailure("method_not_found", "Command allowances are unavailable.");
				}
				cleared = runtime.clearCommandAllowances();
				summary = `cleared=${cleared}`;
			} else {
				return errorCommandResult(
					invocation,
					"Unsupported permissions action",
					"/permissions [allow <pattern>|revoke <pattern>|clear]",
				);
			}
			this.#emitRuntime("status.changed", this.#status());
			return noticeCommandResult(invocation, "Permissions updated", summary, {
				presentation: "transcript",
				extra: { ...(cleared === undefined ? {} : { cleared }) },
			});
		}
		if (invocation.commandId === "compact") {
			const compact = this.#runtime().compact;
			if (!compact) throw new GatewayFailure("method_not_found", "Manual compaction is unavailable.");
			const result = await compact({
				modelOverride: this.#model,
				signal: new AbortController().signal,
			});
			return noticeCommandResult(
				invocation,
				"Context compacted",
				`status=${result.status}; before_tokens=${result.beforeTokens}; after_tokens=${result.afterTokens}`,
				{
					extra: {
						command_kind: "compact",
						compaction_status: result.status,
						tokens: { before: result.beforeTokens, after: result.afterTokens },
					},
				},
			);
		}
		if (invocation.commandId === "resume") {
			if (!invocation.args) {
				return errorCommandResult(invocation, "Session ID is required", "/resume [session-id]");
			}
			const resumed = await this.#sessionResume({ session_id: invocation.args });
			return noticeCommandResult(invocation, "Session resumed", `session=${resumed.session_id}`, {
				extra: { mutated_session: true, session_id: resumed.session_id },
			});
		}
		if (invocation.commandId === "quit") {
			return noticeCommandResult(invocation, "Exit", "Bye.", {
				extra: { exit_requested: true },
			});
		}
		return undefined;
	}

	async #resourceList(): Promise<JsonObject> {
		const resources = await this.#options.integrations?.listResources?.() ?? [];
		return { resources: resources.map(boundedResource).filter(isObject) };
	}

	#sessionList(): JsonObject {
		const coordinator = this.#options.sessionCoordinator;
		if (!coordinator) {
			return {
				sessions: [{
					id: this.#sessionId(),
					workspace: this.#workspaceRoot(),
					cwd: this.#workspaceRoot(),
					current: true,
				}],
			};
		}
		const activeSessionId = coordinator.snapshot().sessionId;
		return {
			sessions: coordinator.listSessions({ limit: 20 }).map((item) => ({
				id: item.sessionId,
				workspace: item.workspaceRoot,
				cwd: item.workspaceRoot,
				created: item.createdAt,
				updated: item.updatedAt,
				last_active: item.lastActiveAt,
				modified: item.lastActiveAt,
				message_count: item.messageCount,
				current: item.sessionId === activeSessionId,
			})),
		};
	}

	async #sessionResume(params: JsonObject): Promise<JsonObject> {
		const coordinator = this.#options.sessionCoordinator;
		if (!coordinator) throw new GatewayFailure("method_not_found", "Session resume is unavailable.");
		if (this.#activeTurn !== null) {
			throw new GatewayFailure("turn_in_progress", "A turn is already running.");
		}
		if (coordinator.snapshot().pendingApproval || coordinator.snapshot().pendingClarification) {
			throw new GatewayFailure("turn_in_progress", "A pending continuation owns the session.");
		}
		const snapshot = await coordinator.resume(requiredString(params.session_id, "session_id"));
		this.#trustState = await this.#loadWorkspaceTrust(snapshot.workspaceRoot);
		this.#configureExecutionPolicy(snapshot.binding);
		this.#bindQueue();
		this.#emitDirect("session.changed", {
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
		});
		this.#emitRuntime("status.changed", this.#status());
		if (snapshot.pendingApproval) {
			this.#emitRuntime("approval.request", approvalRequest(snapshot.pendingApproval, snapshot.generation));
		}
		if (snapshot.pendingClarification) {
			this.#emitRuntime(
				"clarify.request",
				clarificationRequest(snapshot.pendingClarification, snapshot.generation),
			);
		}
		return {
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
			read_only: snapshot.readOnly,
			lines: [],
			background_shells: this.#activeShells().map((shell) =>
				shellSnapshotPayload(shell, this.#sessionContext())),
		};
	}

	#shellList(): JsonObject {
		return {
			session_id: this.#sessionId(),
			generation: this.#sessionContext().generation,
			shells: this.#activeShells().map((snapshot) =>
				shellSnapshotPayload(snapshot, this.#sessionContext())),
		};
	}

	async #shellStop(params: JsonObject): Promise<JsonObject> {
		const manager = this.#requiredShellManager();
		const context = this.#sessionContext();
		const snapshot = await manager.terminate(
			context.sessionId,
			requiredString(params.shell_id, "shell_id"),
		);
		return shellSnapshotPayload(snapshot, context);
	}

	async #shellStopAll(): Promise<JsonObject> {
		const manager = this.#requiredShellManager();
		const context = this.#sessionContext();
		const snapshots = await manager.terminateOwner(context.sessionId);
		return {
			session_id: context.sessionId,
			generation: context.generation,
			stopped: snapshots.length,
			shells: snapshots.map((snapshot) => shellSnapshotPayload(snapshot, context)),
		};
	}

	#sessionTree(params: JsonObject): JsonObject {
		const coordinator = this.#options.sessionCoordinator;
		if (!coordinator) throw new GatewayFailure("method_not_found", "Session tree is unavailable.");
		const active = coordinator.snapshot();
		const requested = optionalString(params.session_id) ?? active.sessionId;
		coordinator.loadSessionLineage(requested);
		const activePath = coordinator.loadSessionLineage(active.sessionId)
			.map((item) => item.sessionId);
		const nodes = coordinator.listSessions({ limit: positiveInteger(params.limit) ?? 100 })
			.map((item) => {
				const lineage = coordinator.loadSessionLineage(item.sessionId);
				const own = lineage.at(-1);
				return {
					id: `session:${item.sessionId}`,
					kind: "session",
					session_id: item.sessionId,
					parent_id: own?.parentId ? `session:${own.parentId}` : null,
					depth: Math.max(0, lineage.length - 1),
					role: "session",
					summary: item.sessionId,
					timestamp: item.lastActiveAt,
					label: "",
					message_index: null,
					tool_name: "",
					active: item.sessionId === active.sessionId,
					on_active_path: activePath.includes(item.sessionId),
					message_count: item.messageCount,
					preview: "",
				};
			});
		return { session_id: active.sessionId, active_path: activePath, nodes };
	}

	#submit(params: JsonObject): JsonObject {
		if (this.#activeTurn !== null) {
			throw new GatewayFailure("turn_in_progress", "A turn is already running.");
		}
		if (this.#options.sessionCoordinator?.snapshot().pendingApproval
			|| this.#options.sessionCoordinator?.snapshot().pendingClarification) {
			throw new GatewayFailure("turn_in_progress", "A pending continuation owns the session.");
		}
		if (this.#options.sessionCoordinator?.snapshot().readOnly) {
			throw new GatewayFailure(
				"session_state_invalid",
				"Session is available for read-only replay only.",
			);
		}
		const message = requiredString(params.message, "message");
		const clientTurnId = requiredString(params.client_turn_id, "client_turn_id");
		const clientUserMessageId = requiredString(
			params.client_user_message_id,
			"client_user_message_id",
		);
		const localImages = stringArray(params.local_images, "local_images");
		const submission: TurnSubmission = {
			clientTurnId,
			clientUserMessageId,
			turnId: this.#options.createTurnId?.()
				?? `turn_${randomUUID().replaceAll("-", "")}`,
			message,
			localImages,
			modelOverride: this.#model,
			...(this.#reasoningEffort ? { reasoningEffort: this.#reasoningEffort } : {}),
		};
		const context = this.#sessionContext();
		const runtime = this.#runtime();
		const coordinator = this.#options.sessionCoordinator;
		if (coordinator && !coordinator.markExecuting(context, true)) {
			throw new GatewayFailure("turn_in_progress", "A session transition is in progress.");
		}
		let reservation: TurnReservation;
		try {
			reservation = runtime.reserve(submission);
		} catch (error) {
			coordinator?.markExecuting(context, false);
			throw error;
		}
		const turnId = reservation.turn.turn_id;
		const active: ActiveTurn = {
			clientTurnId,
			clientUserMessageId,
			controller: new AbortController(),
			context,
			runtime,
			turnId,
			terminalEmitted: false,
		};
		this.#emitUserMessageLifecycle(active, message, "submit");
		this.#activeTurn = active;
		this.#activeTurnTask = new Promise<void>((resolve) => {
			queueMicrotask(() => {
				void this.#runTurn(active, submission, reservation).then(resolve);
			});
		});
		return {
			accepted: true,
			client_turn_id: clientTurnId,
			client_user_message_id: clientUserMessageId,
			turn_id: turnId,
		};
	}

	#approvalRespond(params: JsonObject): JsonObject {
		const coordinator = this.#options.sessionCoordinator;
		if (!coordinator) {
			throw new GatewayFailure("approval_not_pending", "No pending approval is available.");
		}
		if (this.#activeTurn !== null) {
			throw new GatewayFailure("turn_in_progress", "A turn is already running.");
		}
		const snapshot = coordinator.snapshot();
		const pending = snapshot.pendingApproval;
		if (!pending) {
			throw new GatewayFailure("approval_not_pending", "No pending approval is available.");
		}
		const choice = requiredString(params.choice, "choice");
		if (!isApprovalChoice(choice) || !pending.options.includes(choice)) {
			throw new GatewayFailure("invalid_params", "Unsupported approval choice.");
		}
		const decisionId = requiredString(params.decision_id, "decision_id");
		const requestedSessionId = optionalString(params.session_id);
		const requestedGeneration = params.generation === undefined
			? snapshot.generation
			: positiveInteger(params.generation);
		if (requestedGeneration === undefined) {
			throw new GatewayFailure("invalid_params", "generation must be a positive integer.");
		}
		if (decisionId !== pending.decisionId
			|| requestedSessionId !== undefined && requestedSessionId !== snapshot.sessionId
			|| requestedGeneration !== snapshot.generation) {
			throw new GatewayFailure("approval_not_pending", "No pending approval matches the request.");
		}
		const context = coordinator.context();
		if (!coordinator.markExecuting(context, true)) {
			throw new GatewayFailure("turn_in_progress", "A session transition is in progress.");
		}
		const active: ActiveTurn = {
			clientTurnId: pending.clientTurnId,
			clientUserMessageId: pending.clientTurnId,
			controller: new AbortController(),
			context,
			runtime: snapshot.binding,
			turnId: pending.turnId,
			terminalEmitted: false,
		};
		this.#activeTurn = active;
		coordinator.updatePendingApproval(context, undefined);
		this.#emitRuntime("approval.respond", {
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
			decision_id: pending.decisionId,
			choice,
		});
		this.#emitRuntime("status.update", statusPayload("running", pending.clientTurnId));
		this.#activeTurnTask = new Promise<void>((resolve) => {
			queueMicrotask(() => {
				void this.#runApproval(active, { decisionId, choice }, pending).then(resolve);
			});
		});
		return {
			accepted: true,
			decision_id: pending.decisionId,
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
		};
	}

	#clarificationRespond(params: JsonObject): JsonObject {
		const coordinator = this.#options.sessionCoordinator;
		if (!coordinator) {
			throw new GatewayFailure(
				"clarification_not_pending",
				"No pending clarification is available.",
			);
		}
		if (this.#activeTurn !== null) {
			throw new GatewayFailure("turn_in_progress", "A turn is already running.");
		}
		const snapshot = coordinator.snapshot();
		const pending = snapshot.pendingClarification;
		if (!pending) {
			throw new GatewayFailure(
				"clarification_not_pending",
				"No pending clarification is available.",
			);
		}
		const requestId = requiredString(params.request_id, "request_id").trim();
		const response = requiredString(params.response, "response").trim();
		if (response.length > 4_096) {
			throw new GatewayFailure("invalid_params", "response exceeds 4096 characters.");
		}
		if (requestId !== pending.requestId) {
			throw new GatewayFailure(
				"clarification_not_pending",
				"No pending clarification matches the request.",
			);
		}
		const context = coordinator.context();
		if (!coordinator.markExecuting(context, true)) {
			throw new GatewayFailure("turn_in_progress", "A session transition is in progress.");
		}
		const active: ActiveTurn = {
			clientTurnId: pending.clientTurnId,
			clientUserMessageId: pending.clientUserMessageId,
			controller: new AbortController(),
			context,
			runtime: snapshot.binding,
			turnId: pending.turnId,
			terminalEmitted: false,
		};
		this.#activeTurn = active;
		coordinator.updatePendingClarification(context, undefined);
		this.#emitRuntime("turn.started", {
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
		});
		this.#emitRuntime("status.update", statusPayload("running", pending.clientTurnId));
		this.#emitRuntime("clarify.respond", {
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
			request_id: pending.requestId,
			response: boundedString(response, 512),
		});
		this.#activeTurnTask = new Promise<void>((resolve) => {
			queueMicrotask(() => {
				void this.#runClarification(active, { requestId, response }, pending).then(resolve);
			});
		});
		return {
			accepted: true,
			request_id: pending.requestId,
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
		};
	}

	#steer(params: JsonObject): JsonObject {
		const queue = this.#requiredQueueCoordinator();
		const expectedTurnId = requiredString(params.expected_turn_id, "expected_turn_id");
		const active = this.#activeTurn;
		const mutation = queue.enqueueSteer({
			sessionId: this.#sessionId(),
			clientTurnId: queueClientTurnId(params, "steer"),
			expectedTurnId,
			activeTurnId: active?.turnId ?? null,
			steerable: active !== null && !active.controller.signal.aborted,
			text: requiredString(params.message, "message"),
			imagePaths: localImagePaths(params.local_images),
			source: "user",
		});
		return queueMutationResponse(mutation);
	}

	#followUp(params: JsonObject): JsonObject {
		const mutation = this.#requiredQueueCoordinator().enqueueFollowUp({
			sessionId: this.#sessionId(),
			clientTurnId: queueClientTurnId(params, "follow"),
			text: requiredString(params.message, "message"),
			imagePaths: localImagePaths(params.local_images),
			source: "user",
		});
		return queueMutationResponse(mutation);
	}

	#queuePop(): JsonObject {
		const removal = this.#requiredQueueCoordinator().popLastFollowUp();
		return {
			...queueProjection(removal.snapshot),
			item: removal.record ? gatewayQueueItem(removal.record) : null,
		};
	}

	#queueClear(): JsonObject {
		const result = this.#requiredQueueCoordinator().clear();
		const steering = result.records.filter((record) => record.kind === "pending_steer");
		const followUps = result.records.filter((record) => record.kind !== "pending_steer");
		return {
			...queueProjection(result.snapshot),
			steering: steering.map((record) => record.text),
			follow_up: followUps.map((record) => record.text),
			steering_items: steering.map(legacyQueueItem),
			follow_up_items: followUps.map(legacyQueueItem),
		};
	}

	#queueMigrationAck(params: JsonObject): JsonObject {
		const token = requiredString(params.token, "token");
		const snapshot = this.#requiredQueueCoordinator().acknowledgeLegacyMigration(token);
		return { acknowledged: true, token, ...queueProjection(snapshot) };
	}

	async #runTurn(
		active: ActiveTurn,
		submission: TurnSubmission,
		reservation: TurnReservation,
	): Promise<void> {
		let scheduleNext = false;
		try {
			const record = await active.runtime.submit(
				submission,
				(event) => {
					if (this.#isCurrent(active)) this.#projectRuntimeEvent(active, event);
				},
				{ signal: active.controller.signal, reservation },
			);
			if (!active.terminalEmitted && this.#isCurrent(active)) {
				this.#projectStoredTerminal(active, record);
			}
			scheduleNext = record.status === "completed";
		} catch {
			if (!active.terminalEmitted) {
				this.#emitTurnFailure(active, "persistence_error", "Session persistence failed.");
			}
		} finally {
			this.#options.sessionCoordinator?.markExecuting(active.context, false);
			if (this.#activeTurn === active) {
				this.#activeTurn = null;
				this.#activeTurnTask = null;
			}
			if (!this.#closed && this.#isCurrent(active)) {
				this.#emitRuntime("status.changed", this.#status());
			}
			if (scheduleNext && !this.#closed && this.#isCurrent(active)) {
				this.#scheduleNextQueuedTurn();
			}
		}
	}

	async #runApproval(
		active: ActiveTurn,
		input: ResolveApprovalInput,
		pending: PendingSessionApproval,
	): Promise<void> {
		let scheduleNext = false;
		try {
			const record = await active.runtime.resolveApproval(
				input,
				(event) => {
					if (this.#isCurrent(active)) this.#projectRuntimeEvent(active, event);
				},
				{ signal: active.controller.signal },
			);
			if (!active.terminalEmitted && this.#isCurrent(active)) {
				this.#projectStoredTerminal(active, record);
			}
			scheduleNext = record.status === "completed";
		} catch (error) {
			const restored = this.#options.sessionCoordinator
				?.updatePendingApproval(active.context, pending);
			if (restored !== false && !active.terminalEmitted && this.#isCurrent(active)) {
				const failure = gatewayFailure(error);
				this.#emitRuntime("gateway.error", {
					code: failure.code === "persistence_error" ? "internal_error" : failure.code,
					message: failure.message,
					method: "approval.respond",
				});
				this.#emitRuntime(
					"approval.request",
					approvalRequest(pending, active.context.generation),
				);
				this.#emitRuntime(
					"status.update",
					statusPayload("waiting_approval", active.clientTurnId),
				);
			}
		} finally {
			this.#options.sessionCoordinator?.markExecuting(active.context, false);
			if (this.#activeTurn === active) {
				this.#activeTurn = null;
				this.#activeTurnTask = null;
			}
			if (!this.#closed && this.#isCurrent(active)) {
				this.#emitRuntime("status.changed", this.#status());
			}
			if (scheduleNext && !this.#closed && this.#isCurrent(active)) {
				this.#scheduleNextQueuedTurn();
			}
		}
	}

	async #runClarification(
		active: ActiveTurn,
		input: ResolveClarificationInput,
		pending: PendingSessionClarification,
	): Promise<void> {
		let scheduleNext = false;
		try {
			const record = await active.runtime.resolveClarification(
				input,
				(event) => {
					if (this.#isCurrent(active)) this.#projectRuntimeEvent(active, event);
				},
				{ signal: active.controller.signal },
			);
			if (!active.terminalEmitted && this.#isCurrent(active)) {
				this.#projectStoredTerminal(active, record);
			}
			scheduleNext = record.status === "completed";
		} catch (error) {
			const restored = this.#options.sessionCoordinator
				?.updatePendingClarification(active.context, pending);
			if (restored !== false && !active.terminalEmitted && this.#isCurrent(active)) {
				const failure = gatewayFailure(error);
				this.#emitRuntime("gateway.error", {
					code: failure.code === "persistence_error" ? "internal_error" : failure.code,
					message: failure.message,
					method: "clarify.respond",
				});
				this.#emitRuntime(
					"clarify.request",
					clarificationRequest(pending, active.context.generation),
				);
				this.#emitRuntime(
					"turn.status",
					waitingStatus("waiting_clarification", active, "Waiting clarification"),
				);
				this.#emitRuntime(
					"status.update",
					statusPayload("waiting_clarification", active.clientTurnId),
				);
			}
		} finally {
			this.#options.sessionCoordinator?.markExecuting(active.context, false);
			if (this.#activeTurn === active) {
				this.#activeTurn = null;
				this.#activeTurnTask = null;
			}
			if (!this.#closed && this.#isCurrent(active)) {
				this.#emitRuntime("status.changed", this.#status());
			}
			if (scheduleNext && !this.#closed && this.#isCurrent(active)) {
				this.#scheduleNextQueuedTurn();
			}
		}
	}

	#scheduleNextQueuedTurn(): void {
		if (this.#activeTurn !== null) return;
		const queue = this.#queueCoordinator();
		const record = queue?.next();
		if (!queue || !record) return;
		const context = this.#sessionContext();
		const runtime = this.#runtime();
		const coordinator = this.#options.sessionCoordinator;
		if (coordinator && !coordinator.markExecuting(context, true)) return;
		const proposed: TurnSubmission = {
			clientTurnId: record.clientTurnId,
			clientUserMessageId: record.clientTurnId,
			turnId: this.#options.createTurnId?.()
				?? `turn_${randomUUID().replaceAll("-", "")}`,
			message: record.text,
			localImages: record.imagePaths,
			modelOverride: this.#model,
			...(this.#reasoningEffort ? { reasoningEffort: this.#reasoningEffort } : {}),
		};
		let reservation: TurnReservation;
		try {
			reservation = runtime.reserve(proposed);
			queue.markStarted(record.queueId);
		} catch {
			coordinator?.markExecuting(context, false);
			this.#emitRuntime("gateway.error", {
				code: "queue_worker_start_failed",
				message: "Queued turn could not be reserved.",
				method: "turn.submit",
			});
			return;
		}
		const submission: TurnSubmission = {
			...proposed,
			turnId: reservation.turn.turn_id,
		};
		const active: ActiveTurn = {
			clientTurnId: submission.clientTurnId,
			clientUserMessageId: submission.clientTurnId,
			controller: new AbortController(),
			context,
			runtime,
			turnId: reservation.turn.turn_id,
			terminalEmitted: false,
		};
		this.#activeTurn = active;
		this.#activeTurnTask = new Promise<void>((resolve) => {
			queueMicrotask(() => {
				void this.#runTurn(active, submission, reservation).then(resolve);
			});
		});
	}

	#interrupt(): JsonObject {
		const active = this.#activeTurn;
		if (!active) return { accepted: false, requested: false };
		active.controller.abort();
		return {
			accepted: true,
			requested: true,
			client_turn_id: active.clientTurnId,
		};
	}

	#projectRuntimeEvent(active: ActiveTurn, event: RuntimeEvent): void {
		switch (event.type) {
			case "turn_started":
				active.turnId = event.turnId;
				this.#emitRuntime("turn.started", {
					client_turn_id: event.clientTurnId,
					turn_id: event.turnId,
				});
				this.#emitRuntime("status.update", statusPayload("running", active.clientTurnId));
				break;
			case "user_message_started":
			case "user_message_completed":
				this.#emitRuntime(
					event.type === "user_message_started" ? "item.started" : "item.completed",
					{
						client_turn_id: active.clientTurnId,
						turn_id: event.turnId,
						item: {
							id: event.itemId,
							type: "user_message",
							client_user_message_id: event.clientUserMessageId,
							content: event.content,
							source: event.source,
						},
					},
				);
				break;
			case "compaction_started":
				this.#emitRuntime("compaction.started", {
					client_turn_id: event.clientTurnId,
					source: event.source,
					before_tokens: event.beforeTokens,
					max_tokens: event.maxTokens,
				});
				break;
			case "compaction_completed":
				this.#emitRuntime("compaction.completed", {
					client_turn_id: event.clientTurnId,
					source: event.source,
					status: event.status,
					before_tokens: event.beforeTokens,
					after_tokens: event.afterTokens,
					max_tokens: event.maxTokens,
					duration_s: event.durationSeconds,
				});
				break;
			case "text_delta":
				this.#emitRuntime("message.delta", {
					client_turn_id: active.clientTurnId,
					text: event.text,
				});
				this.#emitTurnEvent(active, "assistant_delta", "text_delta", event.text);
				break;
			case "reasoning_delta": {
				const payload = { client_turn_id: active.clientTurnId, text: event.text };
				this.#emitRuntime("reasoning.delta", payload);
				this.#emitRuntime("thinking.delta", payload);
				this.#emitTurnEvent(active, "reasoning", "reasoning", event.text);
				break;
			}
			case "stream_retrying":
				this.#emitRuntime("stream.retrying", {
					client_turn_id: active.clientTurnId,
					text: "Reconnecting...",
					attempt: event.attempt,
					max_retries: Math.max(event.attempt, 1),
					delay_seconds: event.delayMs / 1000,
				});
				break;
			case "stream_recovered":
				this.#emitRuntime("stream.recovered", { client_turn_id: active.clientTurnId });
				break;
			case "message_complete":
				this.#emitRuntime("message.complete", { client_turn_id: active.clientTurnId });
				this.#emitTurnEvent(active, "model_completed", "completed", "", {
					...(event.responseId ? { response_id: event.responseId } : {}),
				});
				break;
			case "tool_call_accepted":
				break;
			case "approval_requested": {
				const approval: PendingSessionApproval = {
					sessionId: active.context.sessionId,
					clientTurnId: event.clientTurnId,
					turnId: event.turnId,
					decisionId: event.decisionId,
					callId: event.callId,
					toolName: event.toolName,
					preview: event.preview,
					reason: event.reason,
					options: event.options,
				};
				if (this.#options.sessionCoordinator?.updatePendingApproval(active.context, approval) === false) {
					break;
				}
				this.#emitRuntime("approval.request", approvalRequest(
					approval,
					active.context.generation,
				));
				this.#emitRuntime(
					"status.update",
					statusPayload("waiting_approval", active.clientTurnId),
				);
				break;
			}
			case "clarification_requested": {
				const clarification: PendingSessionClarification = {
					sessionId: active.context.sessionId,
					clientTurnId: event.clientTurnId,
					clientUserMessageId: active.clientUserMessageId,
					turnId: event.turnId,
					requestId: event.requestId,
					callId: event.callId,
					toolName: event.toolName,
					question: event.question,
					options: event.options,
					header: event.header,
					multiSelect: event.multiSelect,
				};
				if (this.#options.sessionCoordinator
					?.updatePendingClarification(active.context, clarification) === false) {
					break;
				}
				this.#emitRuntime(
					"clarify.request",
					clarificationRequest(clarification, active.context.generation),
				);
				this.#emitRuntime(
					"turn.status",
					waitingStatus("waiting_clarification", active, "Waiting clarification"),
				);
				this.#emitRuntime(
					"status.update",
					statusPayload("waiting_clarification", active.clientTurnId),
				);
				break;
			}
			case "tool_execution_started": {
				const callId = boundedString(event.callId, 256);
				const toolName = boundedString(event.toolName, 128) || "Tool";
				this.#emitRuntime("tool.start", {
					client_turn_id: active.clientTurnId,
					tool_id: toolLifecycleId(callId, toolName),
					call_id: callId,
					name: toolName,
					context: `Executing ${toolName}`,
				});
				this.#emitTurnEvent(active, "tool_execution", "tool_start", "", {
					call_id: callId,
				}, toolName);
				break;
			}
			case "tool_execution_completed":
				this.#emitToolFinished(active, event, true);
				break;
			case "tool_execution_failed":
				this.#emitToolFinished(active, event, false);
				break;
			case "turn_completed":
				active.terminalEmitted = true;
				if (active.controller.signal.aborted) {
					this.#emitRuntime("turn.completion_suppressed", {
						client_turn_id: active.clientTurnId,
						reason: "interrupt_requested",
						suppressed_state: "completed",
					});
					this.#emitInterrupted(active);
				} else {
					this.#emitCompleted(active, event.assistantText, event.usage);
				}
				break;
			case "turn_failed":
				active.terminalEmitted = true;
				this.#emitTurnFailure(active, event.code, event.message);
				break;
			case "turn_interrupted":
				active.terminalEmitted = true;
				this.#emitInterrupted(active);
				break;
		}
	}

	#emitToolFinished(
		active: ActiveTurn,
		event: Extract<RuntimeEvent, {
			readonly type: "tool_execution_completed" | "tool_execution_failed";
		}>,
		success: boolean,
	): void {
		const callId = boundedString(event.callId, 256);
		const toolName = boundedString(event.toolName, 128) || "Tool";
		const summary = boundedString(event.summary, 512);
		const errorKind = event.type === "tool_execution_failed"
			? boundedString(event.errorKind ?? "", 128)
			: "";
		const durationMs = boundedDurationMs(event.durationMs);
		const durationSeconds = durationMs / 1000;
		const method = success ? "tool.complete" : "tool.failed";
		const metadata = safeToolMetadata(event.metadata, success);
		this.#emitRuntime(method, {
			client_turn_id: active.clientTurnId,
			tool_id: toolLifecycleId(callId, toolName),
			call_id: callId,
			name: toolName,
			duration_s: durationSeconds,
			summary,
			summary_chars: summary.length,
			summary_truncated: false,
			success,
			...metadata,
			...(errorKind
				? {
					error_kind: errorKind,
					error: errorKind,
					error_chars: errorKind.length,
					error_truncated: false,
				}
				: {}),
		});
		this.#emitTurnEvent(
			active,
			"tool_execution",
			success ? "tool_complete" : "tool_failed",
			summary,
			{
				call_id: callId,
				duration_ms: durationMs,
				success,
				...metadata,
				...(errorKind ? { error_kind: errorKind } : {}),
			},
			toolName,
		);
	}

	#projectStoredTerminal(active: ActiveTurn, record: RuntimeTurnRecord): void {
		active.turnId ??= record.turn_id;
		if (record.status === "completed") {
			const result = isObject(record.result) ? record.result : {};
			this.#emitCompleted(
				active,
				typeof result.assistant_text === "string" ? result.assistant_text : "",
				isObject(result.usage) ? numberRecord(result.usage) : {},
			);
		} else if (record.status === "interrupted") {
			this.#emitInterrupted(active);
		} else if (record.status === "failed") {
			this.#emitTurnFailure(active, record.error_code ?? "provider_error", "Turn failed.");
		}
	}

	#emitCompleted(active: ActiveTurn, assistantText: string, usage: Readonly<Record<string, number>>): void {
		const turnId = active.turnId ?? active.clientTurnId;
		this.#emitRuntime("turn.completed", {
			client_turn_id: active.clientTurnId,
			turn_id: turnId,
			assistant_message: assistantText,
			activity_events: [],
			progress_updates: [],
			plan_steps: [],
			pending_decision: false,
			turn_state: "completed",
			usage,
		});
		this.#emitRuntime("turn.status", terminalStatus("completed", active, "Completed"));
		this.#emitRuntime("message.complete", {
			client_turn_id: active.clientTurnId,
			text: assistantText,
			final: true,
			source: "turn_response",
		});
		this.#emitRuntime("status.update", statusPayload("completed", active.clientTurnId));
	}

	#emitTurnFailure(active: ActiveTurn, code: RuntimeErrorCode, message: string): void {
		this.#emitRuntime("turn.failed", {
			client_turn_id: active.clientTurnId,
			turn_id: active.turnId ?? active.clientTurnId,
			code,
			message,
		});
		this.#emitRuntime("turn.status", terminalStatus("failed", active, "Failed", message));
		this.#emitRuntime("status.update", statusPayload("failed", active.clientTurnId, message));
	}

	#emitInterrupted(active: ActiveTurn): void {
		this.#emitRuntime("turn.interrupted", {
			client_turn_id: active.clientTurnId,
			turn_id: active.turnId ?? active.clientTurnId,
			code: "interrupted",
			requested: false,
		});
		this.#emitRuntime("turn.status", terminalStatus("interrupted", active, "Interrupted"));
		this.#emitRuntime("status.update", statusPayload("interrupted", active.clientTurnId));
	}

	#status(): JsonObject {
		const session = this.#options.sessionCoordinator?.snapshot();
		const queue = this.#queueCoordinator()?.snapshot() ?? session?.queue;
		const steering = queue?.pendingSteers ?? [];
		const rejectedSteers = queue?.rejectedSteers ?? [];
		const followUps = queue?.followUps ?? [];
		const deferredInputs = [...rejectedSteers, ...followUps];
		const pendingInputCount = steering.length + deferredInputs.length;
		return {
			session_id: this.#sessionId(),
			...(session ? { generation: session.generation } : {}),
			workspace: this.#workspaceRoot(),
			provider: this.#provider,
			model: this.#model,
			...(this.#reasoningEffort ? { thinking_effort: this.#reasoningEffort } : {}),
			collaboration_mode: this.#collaborationMode,
			context_window: {
				used_tokens: 0,
				max_tokens: this.#options.maxPromptTokens ?? 0,
				source: "unknown",
			},
			pending_decision: session?.pendingApproval !== undefined,
			pending_clarification: session?.pendingClarification !== undefined,
			suspended_turn: session?.pendingApproval !== undefined
				|| session?.pendingClarification !== undefined
				|| session?.suspendedTurn === true,
			turn_running: this.#activeTurn !== null,
			turn_id: this.#activeTurn?.turnId ?? null,
			queued_steering: steering.map((item) => item.text),
			queued_follow_up: deferredInputs.map((item) => item.text),
			has_pending_input: pendingInputCount > 0,
			queue_activity: {
				kind: pendingInputCount > 0 ? "pending_input" : "idle",
				has_pending_input: pendingInputCount > 0,
				steering_count: steering.length,
				follow_up_count: deferredInputs.length,
			},
			queue_revision: queue?.revision ?? 0,
			queue_items: {
				pending_steers: queue?.pendingSteers.map(gatewayQueueItem) ?? [],
				rejected_steers: rejectedSteers.map(gatewayQueueItem),
				follow_ups: followUps.map(gatewayQueueItem),
			},
			background_shells: this.#activeShells().map((snapshot) =>
				shellSnapshotPayload(snapshot, this.#sessionContext())),
			trust: this.#trustStatus(),
			permissions: this.#permissions(),
		};
	}

	#trustStatus(): JsonObject {
		return {
			state: this.#trustState,
			workspace: this.#workspaceRoot(),
			source: this.#options.workspaceTrust ? "user_store" : "runtime",
			enforced: this.#runtime().configureExecutionPolicy !== undefined,
		};
	}

	async #setWorkspaceTrust(params: JsonObject): Promise<JsonObject> {
		const state = workspaceTrustState(params.state);
		await this.#options.workspaceTrust?.save(this.#workspaceRoot(), state);
		this.#trustState = state;
		this.#configureExecutionPolicy();
		const payload = this.#trustStatus();
		this.#emitRuntime("workspace.trust.changed", payload);
		this.#emitRuntime("status.changed", this.#status());
		return payload;
	}

	#permissions(): JsonObject {
		return permissionPayload(
			this.#permissionProfile,
			this.#runtime().listCommandAllowances?.().length ?? 0,
		);
	}

	#updatePermissions(params: JsonObject): JsonObject {
		this.#permissionProfile = permissionProfile(params.profile);
		this.#configureExecutionPolicy();
		const permissions = this.#permissions();
		const status = this.#status();
		this.#emitRuntime("status.changed", status);
		return { permissions, status };
	}

	#configureExecutionPolicy(runtime: NodeGatewayRuntime = this.#runtime()): void {
		runtime.configureExecutionPolicy?.({
			trust: this.#trustState,
			permission: this.#permissionProfile,
		});
	}

	async #loadWorkspaceTrust(workspaceRoot: string): Promise<WorkspaceTrustState> {
		try {
			return await this.#options.workspaceTrust?.load(workspaceRoot) ?? "unknown";
		} catch {
			return "unknown";
		}
	}

	#sessionId(): string {
		return this.#options.sessionCoordinator?.snapshot().sessionId ?? this.#options.sessionId;
	}

	#workspaceRoot(): string {
		return this.#options.sessionCoordinator?.snapshot().workspaceRoot
			?? this.#options.workspaceRoot;
	}

	#runtime(): NodeGatewayRuntime {
		return this.#options.sessionCoordinator?.snapshot().binding ?? this.#options.runtime;
	}

	#queueCoordinator(): QueueCoordinator | undefined {
		return this.#runtime().queueCoordinator;
	}

	#requiredQueueCoordinator(): QueueCoordinator {
		const queue = this.#queueCoordinator();
		if (!queue) throw new GatewayFailure("method_not_found", "Queue operations are unavailable.");
		return queue;
	}

	#requiredShellManager(): NonNullable<CreateNodeGatewayOptions["shellManager"]> {
		const manager = this.#options.shellManager;
		if (!manager) throw new GatewayFailure("method_not_found", "Shell operations are unavailable.");
		return manager;
	}

	#activeShells(): readonly ShellSessionSnapshot[] {
		const ownerSessionId = this.#sessionId();
		return this.#options.shellManager?.list(ownerSessionId).filter((snapshot) =>
			snapshot.ownerSessionId === ownerSessionId
				&& snapshot.background
				&& snapshot.status === "running"
				&& snapshot.processState === "running_background") ?? [];
	}

	#bindQueue(): void {
		this.#unsubscribeQueue?.();
		this.#unsubscribeQueue = null;
		const queue = this.#queueCoordinator();
		if (!queue) return;
		const context = this.#sessionContext();
		this.#unsubscribeQueue = queue.subscribe((snapshot) => {
			if (this.#closed) return;
			const sessions = this.#options.sessionCoordinator;
			if (sessions) {
				if (!sessions.updateQueue(context, snapshot)) return;
			} else if (snapshot.sessionId !== context.sessionId) {
				return;
			}
			this.#emitRuntime("turn.queue.updated", queueEventPayload(snapshot, context));
		});
	}

	#bindShellLifecycle(): void {
		this.#unsubscribeShell?.();
		this.#unsubscribeShell = this.#options.shellLifecycle?.subscribe((event) => {
			if (this.#closed) return;
			const context = this.#sessionContext();
			if (event.ownerSessionId !== context.sessionId) return;
			this.#emitRuntime(event.kind, shellLifecyclePayload(event, context.generation));
		}) ?? null;
	}

	#bindSubagents(): void {
		this.#unsubscribeSubagents = this.#options.integrations?.subscribeSubagents?.((value) => {
			const parentSessionId = boundedRequiredValue(value.parent_session_id, 256);
			if (parentSessionId && parentSessionId !== this.#sessionContext().sessionId) return;
			const subagent = boundedSubagent(value);
			if (subagent) this.#emitRuntime("subagent.updated", { subagent });
		}) ?? null;
	}

	#sessionContext(): SessionGenerationContext {
		return this.#options.sessionCoordinator?.context()
			?? Object.freeze({ sessionId: this.#options.sessionId, generation: 1 });
	}

	#isCurrent(active: ActiveTurn): boolean {
		return this.#options.sessionCoordinator?.isCurrent(active.context) ?? true;
	}

	#emitTurnEvent(
		active: ActiveTurn,
		phase: string,
		kind: string,
		text: string,
		metadata: JsonObject = {},
		toolName: string | null = null,
	): void {
		this.#emitRuntime("turn.event", {
			client_turn_id: active.clientTurnId,
			phase,
			kind,
			text,
			tool_name: toolName,
			metadata,
		});
	}

	#emitUserMessageLifecycle(
		active: ActiveTurn,
		content: string,
		source: "submit" | "steer",
	): void {
		const turnId = active.turnId ?? active.clientTurnId;
		const params = {
			client_turn_id: active.clientTurnId,
			turn_id: turnId,
			item: {
				id: `${turnId}:user:${active.clientUserMessageId}`,
				type: "user_message",
				client_user_message_id: active.clientUserMessageId,
				content,
				source,
			},
		};
		this.#emitRuntime("item.started", params);
		this.#emitRuntime("item.completed", params);
	}

	#emitRuntime(method: string, params: JsonObject): void {
		this.#emitDirect(method, params);
		this.#sequence += 1;
		this.#emitDirect("runtime.event", {
			version: 1,
			sequence: this.#sequence,
			type: method,
			payload: params,
			timestamp: this.#clock(),
		});
	}

	#emitDirect(method: string, params: JsonObject): void {
		const notification = { jsonrpc: "2.0" as const, method, params };
		parseGatewayEvent(notification);
		this.#write(notification);
	}

	#writeResult(id: RpcId, result: JsonObject): void {
		this.#write({ jsonrpc: "2.0", id, result });
	}

	#writeError(id: RpcId, code: string, message: string): void {
		this.#write({ jsonrpc: "2.0", id, error: { code, message } });
	}

	#write(message: object): void {
		if (!this.#closed) this.#clientInput.write(`${JSON.stringify(message)}\n`);
	}
}

export function createNodeGateway(options: CreateNodeGatewayOptions): NodeGateway {
	return new InProcessNodeGateway(options);
}

function shellPsCommandResult(processes: readonly JsonObject[]): JsonObject {
	const lines = processes.length === 0
		? ["no background shells"]
		: processes.map((process) => [
			String(process.shell_id ?? "shell"),
			String(process.process_state ?? "running"),
			String(process.command_preview ?? "[redacted command]"),
		].join(" "));
	return {
		result_id: `command:${randomUUID().replaceAll("-", "")}`,
		presentation: "transcript",
		command_kind: "background_shells",
		processes,
		lines,
		display: shellCommandDisplay({
			kind: "list",
			command: "/ps",
			title: "Background terminals",
			severity: "info",
			rows: processes.map((process) => ({
				key: String(process.shell_id ?? "shell"),
				label: `shell ${String(process.shell_id ?? "unknown")}`,
				values: [String(process.command_preview ?? "[redacted command]")],
				status: String(process.process_state ?? "running"),
			})),
			totalRows: processes.length,
		}),
	};
}

function shellStopCommandResult(stopped: JsonObject): JsonObject {
	return {
		result_id: `command:${randomUUID().replaceAll("-", "")}`,
		presentation: "none",
		command_kind: "shell_stop",
		lines: ["Stopping all background terminals."],
		stopped: stopped.stopped ?? 0,
		display: shellCommandDisplay({
			kind: "notice",
			command: "/stop",
			title: "Background terminals",
			severity: "success",
			summary: "Stopping all background terminals.",
		}),
	};
}

function shellCommandDisplay(input: {
	readonly kind: "list" | "notice";
	readonly command: string;
	readonly title: string;
	readonly severity: "info" | "success";
	readonly summary?: string;
	readonly rows?: readonly JsonObject[];
	readonly totalRows?: number;
}): JsonObject {
	return {
		version: 1,
		kind: input.kind,
		command: input.command,
		title: input.title,
		severity: input.severity,
		...(input.summary ? { summary: input.summary } : {}),
		fields: [],
		rows: input.rows ?? [],
		sections: [],
		suggestions: [],
		...(input.totalRows === undefined ? {} : { total_rows: input.totalRows }),
		omitted_rows: 0,
		omitted_chars: 0,
	};
}

function shellSnapshotPayload(
	snapshot: ShellSessionSnapshot,
	context: SessionGenerationContext,
): JsonObject {
	const metadata = sanitizeShellSnapshotPayload({
		...(snapshot.commandPreview ? { command_preview: snapshot.commandPreview } : {}),
		process_state: snapshot.processState,
		...(snapshot.terminalState ? { terminal_state: snapshot.terminalState } : {}),
		...(snapshot.transport ? { transport: snapshot.transport } : {}),
		...(snapshot.cleanupResult ? { cleanup_result: snapshot.cleanupResult } : {}),
		...(snapshot.startedAt ? { started_at: snapshot.startedAt } : {}),
		...(snapshot.completedAt ? { completed_at: snapshot.completedAt } : {}),
		...(snapshot.shellKind ? { shell_kind: snapshot.shellKind } : {}),
		...(snapshot.shellEdition ? { shell_edition: snapshot.shellEdition } : {}),
	}, snapshot.shellId);
	const discardedOutputChars = Math.max(
		0,
		snapshot.output.length - SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS,
	);
	const output = discardedOutputChars > 0
		? snapshot.output.slice(-SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS)
		: snapshot.output;
	return {
		shell_id: snapshot.shellId,
		session_id: context.sessionId,
		generation: context.generation,
		...(snapshot.callId ? { call_id: snapshot.callId } : {}),
		...(metadata.command_preview ? { command_preview: metadata.command_preview } : {}),
		background: snapshot.background,
		status: snapshot.status,
		process_state: metadata.process_state ?? snapshot.processState,
		...(metadata.terminal_state ? { terminal_state: metadata.terminal_state } : {}),
		...(snapshot.exitCode === undefined ? {} : { exit_code: snapshot.exitCode }),
		output,
		next_cursor: snapshot.nextCursor,
		output_chars: snapshot.outputChars,
		omitted_output_chars: snapshot.omittedOutputChars + discardedOutputChars,
		...(metadata.transport ? { transport: metadata.transport } : {}),
		tty: snapshot.tty,
		yielded: snapshot.yielded,
		...(metadata.cleanup_result ? { cleanup_result: metadata.cleanup_result } : {}),
		...(metadata.started_at ? { started_at: metadata.started_at } : {}),
		...(metadata.completed_at ? { completed_at: metadata.completed_at } : {}),
		...(metadata.shell_kind ? { shell_kind: metadata.shell_kind } : {}),
		...(metadata.shell_edition ? { shell_edition: metadata.shell_edition } : {}),
		...(snapshot.errorKind ? { error_kind: snapshot.errorKind } : {}),
		...(snapshot.error ? { error: snapshot.error.slice(0, 512) } : {}),
	};
}

function shellLifecyclePayload(
	event: ShellLifecycleEvent,
	generation: number,
): JsonObject {
	const metadata = sanitizeShellSnapshotPayload({
		command_preview: event.commandPreview,
		process_state: event.processState,
		...(event.terminalState ? { terminal_state: event.terminalState } : {}),
		...(event.transport ? { transport: event.transport } : {}),
		...(event.cleanupResult ? { cleanup_result: event.cleanupResult } : {}),
		...(event.startedAt ? { started_at: event.startedAt } : {}),
		...(event.completedAt ? { completed_at: event.completedAt } : {}),
		...(event.shellKind ? { shell_kind: event.shellKind } : {}),
		...(event.shellEdition ? { shell_edition: event.shellEdition } : {}),
	}, event.shellId);
	const outputDelta = event.outputDelta === undefined
		? undefined
		: event.outputDelta.slice(-10_000);
	const discardedOutputChars = event.outputDelta === undefined
		? 0
		: Math.max(0, event.outputDelta.length - (outputDelta?.length ?? 0));
	return {
		shell_id: event.shellId,
		session_id: event.ownerSessionId,
		generation,
		call_id: event.callId,
		sequence: event.sequence,
		command_preview: metadata.command_preview ?? "[redacted command]",
		background: event.background,
		process_state: metadata.process_state ?? event.processState,
		...(metadata.transport ? { transport: metadata.transport } : {}),
		tty: event.tty,
		yielded: event.yielded,
		...(metadata.terminal_state ? { terminal_state: metadata.terminal_state } : {}),
		...(event.exitCode === undefined ? {} : { exit_code: event.exitCode }),
		...(outputDelta === undefined ? {} : { output_delta: outputDelta }),
		...(event.nextCursor === undefined ? {} : { next_cursor: event.nextCursor }),
		...(event.outputChars === undefined ? {} : { output_chars: event.outputChars }),
		...((event.omittedOutputChars ?? 0) + discardedOutputChars > 0
			? { omitted_output_chars: (event.omittedOutputChars ?? 0) + discardedOutputChars }
			: {}),
		...(metadata.cleanup_result ? { cleanup_result: metadata.cleanup_result } : {}),
		...(metadata.started_at ? { started_at: metadata.started_at } : {}),
		...(metadata.completed_at ? { completed_at: metadata.completed_at } : {}),
		...(event.activeBackgroundCount === undefined
			? {}
			: { active_background_count: event.activeBackgroundCount }),
		...(metadata.shell_kind ? { shell_kind: metadata.shell_kind } : {}),
		...(metadata.shell_edition ? { shell_edition: metadata.shell_edition } : {}),
	};
}

class GatewayFailure extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

function gatewayFailure(error: unknown): GatewayFailure {
	if (error instanceof GatewayFailure) return error;
	if (error instanceof SlashCommandError) {
		return new GatewayFailure(error.code, error.message);
	}
	if (isObject(error) && error.code === "session_state_invalid") {
		return new GatewayFailure("session_state_invalid", "Persisted session state is invalid.");
	}
	if (isObject(error) && error.code === "session_state_version_unsupported") {
		return new GatewayFailure(
			"session_state_version_unsupported",
			"Persisted session state version is unsupported.",
		);
	}
	if (isObject(error) && error.code === "session_not_found") {
		return new GatewayFailure("session_not_found", "Session was not found.");
	}
	if (isObject(error) && error.code === "turn_in_progress") {
		return new GatewayFailure("turn_in_progress", "A turn is already running.");
	}
	if (isObject(error) && error.code === "message_id_conflict") {
		return new GatewayFailure(
			"message_id_conflict",
			"client_turn_id already has a different payload.",
		);
	}
	if (error instanceof StorageFailure || (isObject(error) && error.code === "persistence_error")) {
		return new GatewayFailure("persistence_error", "Session persistence failed.");
	}
	if (isObject(error) && error.code === "queue_conflict") {
		return new GatewayFailure("queue_conflict", "Queued input conflicts with current state.");
	}
	if (isObject(error) && error.code === "queue_capacity") {
		return new GatewayFailure("queue_capacity", "Queued input exceeds the queue capacity.");
	}
	if (isObject(error) && error.code === "approval_not_pending") {
		return new GatewayFailure("approval_not_pending", "No pending approval is available.");
	}
	if (isObject(error) && error.code === "approval_conflict") {
		return new GatewayFailure("approval_conflict", "Approval state conflicts with the request.");
	}
	return new GatewayFailure("internal_error", "Gateway request failed.");
}

function gatewayTranscriptItem(item: TranscriptItem): JsonObject {
	const type = {
		user_message: "user",
		assistant_message: "assistant_final",
		reasoning_summary: "reasoning",
		tool: "tool_summary",
		warning: "warning",
		status: "system_notice",
		file_change: "system_notice",
		plan_update: "plan_update",
	}[item.type];
	const metadata: JsonObject = { ...(item.metadata ?? {}) };
	if (item.type === "tool") {
		if (item.tool_name) metadata.tool_name = item.tool_name;
		if (item.call_id) metadata.call_id = item.call_id;
		if (item.command) metadata.command = item.command;
		if (item.exit_code !== undefined) metadata.exit_code = item.exit_code;
		if (item.duration_ms !== undefined) metadata.duration_ms = item.duration_ms;
		if (item.truncated) metadata.truncated = true;
		if (item.omitted_chars !== undefined) metadata.omitted_chars = item.omitted_chars;
		if (item.status) {
			metadata.status = item.status === "completed" ? "done" : item.status;
			if (item.status === "completed" && metadata.success === undefined) metadata.success = true;
		}
		if (item.output) metadata.output_preview = item.output;
	}
	return {
		id: item.id,
		type,
		text: item.text ?? (item.type === "tool" ? item.tool_name ?? "Tool" : ""),
		created_at: item.created_at ?? "",
		folded: false,
		metadata,
	};
}

function paginatedTranscript(
	sessionId: string,
	projected: readonly JsonObject[],
	params: JsonObject,
	readOnly = false,
): JsonObject {
	const before = optionalString(params.before);
	const beforeIndex = before
		? projected.findIndex((item) => item.id === before)
		: projected.length;
	const end = beforeIndex < 0 ? projected.length : beforeIndex;
	const limit = positiveInteger(params.limit);
	const selected = limit === undefined
		? projected.slice(0, end)
		: projected.slice(Math.max(0, end - limit), end);
	return {
		session_id: sessionId,
		items: selected,
		next_before: selected.length < end ? selected[0]?.id ?? null : null,
		read_only: readOnly,
	};
}

function approvalRequest(
	approval: PendingSessionApproval,
	generation: number,
): JsonObject {
	return {
		session_id: approval.sessionId,
		generation,
		client_turn_id: approval.clientTurnId,
		turn_id: approval.turnId,
		decision_id: approval.decisionId,
		call_id: approval.callId,
		preview: approval.preview,
		reason: approval.reason,
		tool_name: approval.toolName,
		action: approval.toolName,
		options: approval.options.map((choice) => ({
			choice,
			label: approvalChoiceLabel(choice),
		})),
	};
}

function clarificationRequest(
	clarification: PendingSessionClarification,
	generation: number,
): JsonObject {
	return {
		session_id: clarification.sessionId,
		generation,
		client_turn_id: clarification.clientTurnId,
		turn_id: clarification.turnId,
		request_id: clarification.requestId,
		tool_id: clarification.callId,
		call_id: clarification.callId,
		tool_name: clarification.toolName,
		question: clarification.question,
		options: clarification.options.map((option) => ({ ...option })),
		header: clarification.header,
		multi_select: clarification.multiSelect,
	};
}

function approvalChoiceLabel(choice: PendingSessionApproval["options"][number]): string {
	return {
		approve_once: "Approve once",
		reject: "Reject",
		allow_session: "Allow for session",
		always_allow: "Always allow",
	}[choice];
}

function isApprovalChoice(value: string): value is PendingSessionApproval["options"][number] {
	return value === "approve_once"
		|| value === "reject"
		|| value === "allow_session"
		|| value === "always_allow";
}

function gatewayQueueItem(item: QueuedInput): JsonObject {
	return {
		queue_id: item.queueId,
		session_id: item.sessionId,
		client_turn_id: item.clientTurnId,
		target_turn_id: item.targetTurnId,
		kind: item.kind,
		state: item.state,
		message: item.text,
		text: item.text,
		source: item.source,
		created_at: item.createdAt,
		updated_at: item.updatedAt,
		...(item.imagePaths.length > 0 ? {
			local_images: item.imagePaths.map((path, index) => ({
				path,
				placeholder: `[image #${index + 1}]`,
			})),
		} : {}),
	};
}

function queueMutationResponse(mutation: QueueMutation): JsonObject {
	return {
		accepted: true,
		disposition: mutation.disposition,
		record: gatewayQueueItem(mutation.record),
		...queueProjection(mutation.snapshot),
	};
}

function queueEventPayload(
	snapshot: QueueSnapshot,
	context: SessionGenerationContext,
): JsonObject {
	return {
		session_id: snapshot.sessionId,
		generation: context.generation,
		revision: snapshot.revision,
		...queueProjection(snapshot),
	};
}

function queueProjection(snapshot: QueueSnapshot): JsonObject {
	const pending = snapshot.pendingSteers.filter(isVisibleQueueItem);
	const deferred = [...snapshot.rejectedSteers, ...snapshot.followUps].filter(isVisibleQueueItem);
	const hasPendingInput = pending.length + deferred.length > 0;
	return {
		queue_revision: snapshot.revision,
		queue_items: {
			pending_steers: snapshot.pendingSteers.map(gatewayQueueItem),
			rejected_steers: snapshot.rejectedSteers.map(gatewayQueueItem),
			follow_ups: snapshot.followUps.map(gatewayQueueItem),
		},
		steering: pending.map((item) => item.text),
		follow_up: deferred.map((item) => item.text),
		steering_items: pending.map(legacyQueueItem),
		follow_up_items: deferred.map(legacyQueueItem),
		has_pending_input: hasPendingInput,
		steering_count: pending.length,
		follow_up_count: deferred.length,
		activity: {
			kind: hasPendingInput ? "pending_input" : "idle",
			has_pending_input: hasPendingInput,
			steering_count: pending.length,
			follow_up_count: deferred.length,
		},
	};
}

function legacyQueueItem(item: QueuedInput): JsonObject {
	return {
		client_turn_id: item.clientTurnId,
		kind: item.kind === "pending_steer" ? "steering" : item.kind,
		message: item.text,
		text: item.text,
		source: item.source,
		...(item.imagePaths.length > 0 ? {
			local_images: item.imagePaths.map((path, index) => ({
				path,
				placeholder: `[image #${index + 1}]`,
			})),
		} : {}),
	};
}

function legacyMigrationRecord(item: QueuedInput): JsonObject {
	return {
		queue_id: item.queueId,
		kind: item.kind,
		text: item.text,
		...(item.imagePaths.length > 0 ? {
			local_images: item.imagePaths.map((path, index) => ({
				path,
				placeholder: `[image #${index + 1}]`,
			})),
		} : {}),
	};
}

function isVisibleQueueItem(item: QueuedInput): boolean {
	return item.source !== "task_notification";
}

function queueClientTurnId(params: JsonObject, prefix: string): string {
	return optionalString(params.client_turn_id)
		?? optionalString(params.client_user_message_id)
		?? `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function localImagePaths(value: unknown): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new GatewayFailure("invalid_params", "local_images must be an array.");
	}
	return value.map((item) => {
		if (typeof item === "string" && item.trim()) return item;
		if (isObject(item) && typeof item.path === "string" && item.path.trim()) return item.path;
		throw new GatewayFailure("invalid_params", "local_images contains an invalid path.");
	});
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value > 0
		? value
		: undefined;
}

function permissionProfile(value: unknown): PermissionProfile {
	if (value === "read-only" || value === "workspace" || value === "full-access") {
		return value;
	}
	throw new GatewayFailure("invalid_params", "Unsupported permission profile.");
}

function permissionPayload(active: PermissionProfile, commandAllowanceCount = 0): JsonObject {
	return {
		active,
		command_allowance_count: commandAllowanceCount,
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

function extensionManifest(toolNames: readonly string[], toolManifest?: JsonObject): JsonObject {
	return {
		schema_version: 1,
		agent: { name: "mycli", version: "0.1.0", runtime: "node" },
		rpc_methods: gatewayContractCatalog.rpcMethods.map((name) => ({ name })),
		event_streams: gatewayContractCatalog.eventStreams.map((name) => ({ name })),
		capabilities: {
			no_tool_turns: true,
			tools: toolNames.length > 0,
			tool_names: toolNames,
		},
		...(toolManifest ? { tool_manifest: toolManifest } : {}),
	};
}

function boundedResource(value: JsonObject): JsonObject {
	const resource: JsonObject = {};
	for (const key of ["id", "type", "name", "source", "status", "detail", "command"] as const) {
		const item = value[key];
		if (typeof item === "string" && item.trim()) {
			resource[key] = boundedString(item.trim(), key === "detail" ? 512 : 256);
		}
	}
	if (typeof value.enabled === "boolean") resource.enabled = value.enabled;
	return resource;
}

function boundedSubagent(
	value: Readonly<Record<string, unknown>>,
): JsonObject | undefined {
	const runId = boundedRequiredValue(value.run_id, 256);
	const childSessionId = boundedRequiredValue(value.child_session_id, 256);
	const role = boundedRequiredValue(value.role, 64);
	const status = boundedRequiredValue(value.status, 32);
	const summary = boundedRequiredValue(value.summary, 512);
	if (!runId || !childSessionId || !role || !status || !summary) return undefined;
	const progress = Array.isArray(value.progress)
		? value.progress.slice(0, 32).flatMap((item) => {
			if (!isObject(item)) return [];
			const kind = boundedRequiredValue(item.kind, 64);
			if (!kind) return [];
			return [{
				kind,
				...(boundedOptionalValue(item.tool_name, 128) ? {
					tool_name: boundedOptionalValue(item.tool_name, 128),
				} : {}),
				...(boundedOptionalValue(item.summary, 512) ? {
					summary: boundedOptionalValue(item.summary, 512),
				} : {}),
			}];
		})
		: [];
	return {
		run_id: runId,
		child_session_id: childSessionId,
		role,
		status,
		summary,
		progress,
	};
}

function boundedRequiredValue(value: unknown, limit: number): string | undefined {
	return typeof value === "string" && value.trim()
		? boundedString(value.trim(), limit)
		: undefined;
}

function boundedOptionalValue(value: unknown, limit: number): string | undefined {
	return boundedRequiredValue(value, limit);
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new GatewayFailure("invalid_params", `${name} is required.`);
	}
	return value;
}

function slashCommandSurface(value: unknown): SlashCommandSurface {
	if (value === "cli" || value === "tui") return value;
	throw new GatewayFailure("invalid_params", "surface must be cli or tui.");
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function reasoningEffort(value: unknown): ReasoningEffort | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (
		value === "none"
		|| value === "minimal"
		|| value === "low"
		|| value === "medium"
		|| value === "high"
		|| value === "xhigh"
	) {
		return value;
	}
	throw new GatewayFailure("invalid_params", "Unsupported reasoning_effort.");
}

function workspaceTrustState(value: unknown): WorkspaceTrustState {
	if (value === "trusted" || value === "untrusted" || value === "unknown") {
		return value;
	}
	throw new GatewayFailure(
		"invalid_params",
		"state must be trusted, untrusted, or unknown.",
	);
}

function stringArray(value: unknown, name: string): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new GatewayFailure("invalid_params", `${name} must be an array of strings.`);
	}
	return value;
}

function statusPayload(state: string, clientTurnId: string, message?: string): JsonObject {
	return {
		state,
		kind: state,
		text: state === "running"
			? "Running"
			: state === "waiting_approval"
				? "Waiting approval"
				: state === "waiting_clarification"
					? "Waiting clarification"
				: state === "completed"
					? "Completed"
					: state === "interrupted"
						? "Interrupted"
						: "Failed",
		client_turn_id: clientTurnId,
		...(message ? { message } : {}),
	};
}

function aggregateUsage(rollouts: readonly JsonObject[]): Readonly<Record<string, number>> {
	const totals: Record<string, number> = { turns: rollouts.length };
	for (const rollout of rollouts) {
		const continuation = isObject(rollout.continuation_state)
			? rollout.continuation_state
			: undefined;
		const usage = continuation && isObject(continuation.usage) ? continuation.usage : undefined;
		if (!usage) continue;
		for (const [key, value] of Object.entries(usage)) {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
			totals[key.slice(0, 64)] = (totals[key.slice(0, 64)] ?? 0) + value;
		}
	}
	return totals;
}

function fileChangeRows(transcript: readonly TranscriptItem[]): readonly {
	readonly key: string;
	readonly label: string;
	readonly values: readonly string[];
	readonly status?: string;
}[] {
	const rows: Array<{
		readonly key: string;
		readonly label: string;
		readonly values: readonly string[];
		readonly status?: string;
	}> = [];
	for (const item of transcript) {
		const changes = Array.isArray(item.metadata?.file_changes)
			? item.metadata.file_changes
			: [];
		for (const [index, value] of changes.entries()) {
			if (!isObject(value) || typeof value.path !== "string") continue;
			rows.push({
				key: `change:${item.id}:${index}`,
				label: value.path,
				values: [
					`+${typeof value.added_lines === "number" ? value.added_lines : 0}`,
					`-${typeof value.removed_lines === "number" ? value.removed_lines : 0}`,
				],
				...(typeof value.kind === "string" ? { status: value.kind } : {}),
			});
		}
	}
	return rows;
}

function humanize(value: string): string {
	const normalized = value.replaceAll(/[-_]+/gu, " ").trim();
	return normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : "Value";
}

function parseForkArguments(args: string, currentSessionId: string): {
	readonly sourceSessionId: string;
	readonly targetSessionId: string;
	readonly forkPoint?: number;
} {
	const parts = shellWords(args);
	if (parts.length > 3) throw new Error("too many fork arguments");
	const sourceSessionId = parts.length >= 2 ? parts[0]! : currentSessionId;
	const targetSessionId = parts.length === 0
		? `${currentSessionId}-fork`
		: parts.length === 1
			? parts[0]!
			: parts[1]!;
	if ([sourceSessionId, targetSessionId].some((value) =>
		!value || value.length > 256 || value.includes("\0"))) {
		throw new Error("invalid session id");
	}
	if (parts.length < 3) return { sourceSessionId, targetSessionId };
	const forkPoint = Number(parts[2]);
	if (!Number.isSafeInteger(forkPoint) || forkPoint < 0 || String(forkPoint) !== parts[2]) {
		throw new Error("invalid fork point");
	}
	return { sourceSessionId, targetSessionId, forkPoint };
}

function shellWords(value: string): readonly string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const character of value.trim()) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/u.test(character)) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}
	if (escaped || quote) throw new Error("unterminated shell word");
	if (current) words.push(current);
	return words;
}

function sessionMaintenanceAction(
	value: string,
): "report" | "empty" | "orphans" | "vacuum" | undefined {
	return {
		"": "report" as const,
		"--apply-empty": "empty" as const,
		"--apply-orphans": "orphans" as const,
		"--apply-vacuum": "vacuum" as const,
	}[value];
}

function commandObjectRows(value: JsonObject): readonly {
	readonly key: string;
	readonly label: string;
	readonly values: readonly string[];
}[] {
	return Object.entries(value).slice(0, 100).map(([key, item]) => ({
		key,
		label: humanize(key),
		values: [commandPrimitiveValue(item)],
	}));
}

function commandObjectSummary(value: JsonObject): string {
	return Object.entries(value).slice(0, 20)
		.map(([key, item]) => `${key}=${commandPrimitiveValue(item)}`)
		.join("; ") || "completed";
}

function commandPrimitiveValue(value: unknown): string {
	if (typeof value === "string") return value.slice(0, 512);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
	if (Array.isArray(value)) return `items:${value.length}`;
	if (isObject(value)) return `fields:${Object.keys(value).length}`;
	return "unknown";
}

function parseModelSelection(args: string): {
	readonly model?: string;
	readonly reasoningEffort?: ReasoningEffort;
} {
	const parts = args.trim() ? args.trim().split(/\s+/u) : [];
	let model: string | undefined;
	let reasoningEffort: ReasoningEffort | undefined;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index]!;
		if (part === "--thinking-effort") {
			const value = parts[index + 1];
			if (!value) throw new GatewayFailure("invalid_arguments", "--thinking-effort requires a value.");
			reasoningEffort = reasoningEffortValue(value);
			index += 1;
			continue;
		}
		if (part.startsWith("--thinking-effort=")) {
			reasoningEffort = reasoningEffortValue(part.slice("--thinking-effort=".length));
			continue;
		}
		if (part.startsWith("--")) {
			throw new GatewayFailure("invalid_arguments", `Unsupported model option: ${part}`);
		}
		if (model) throw new GatewayFailure("invalid_arguments", "Only one model may be selected.");
		model = part.slice(0, 256);
	}
	return {
		...(model ? { model } : {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
	};
}

function reasoningEffortValue(value: string): ReasoningEffort {
	if (["none", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
		return value as ReasoningEffort;
	}
	throw new GatewayFailure("invalid_arguments", "Unsupported thinking effort.");
}

function requestedSandboxMode(
	value: string,
	currentPermission: PermissionProfile,
): "read-only" | "workspace-write" | "danger-full-access" {
	const current = sandboxForPermission(currentPermission);
	if (!value) return current;
	if (value === "next") {
		return current === "read-only"
			? "workspace-write"
			: current === "workspace-write"
				? "danger-full-access"
				: "read-only";
	}
	if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
		return value;
	}
	throw new GatewayFailure("invalid_arguments", "Unsupported sandbox mode.");
}

function sandboxForPermission(
	value: PermissionProfile,
): "read-only" | "workspace-write" | "danger-full-access" {
	return value === "read-only"
		? "read-only"
		: value === "workspace"
			? "workspace-write"
			: "danger-full-access";
}

function permissionForSandbox(
	value: "read-only" | "workspace-write" | "danger-full-access",
): PermissionProfile {
	return value === "read-only" ? "read-only" : value === "workspace-write" ? "workspace" : "full-access";
}

function memoryRows(memories: readonly JsonObject[]): readonly {
	readonly key: string;
	readonly label: string;
	readonly values: readonly string[];
	readonly status?: string;
	readonly detail?: string;
}[] {
	return memories.slice(0, 100).map((memory, index) => ({
		key: `memory:${index}:${String(memory.filename ?? "entry")}`,
		label: String(memory.name ?? memory.filename ?? "Memory"),
		values: [String(memory.filename ?? "")].filter(Boolean),
		...(typeof memory.kind === "string" ? { status: memory.kind } : {}),
		...(typeof memory.description === "string" && memory.description
			? { detail: memory.description }
			: {}),
	}));
}

function parseMemoryAdd(value: string): {
	readonly kind: "user" | "feedback" | "project" | "reference";
	readonly name: string;
	readonly description: string;
	readonly content: string;
} {
	const separator = value.indexOf("::");
	if (separator < 0) {
		throw new GatewayFailure("invalid_arguments", "Use /memory add <type> <name> :: <content>.");
	}
	const header = value.slice(0, separator).trim();
	const content = value.slice(separator + 2).trim();
	const [rawKind, ...nameParts] = header.split(/\s+/u);
	const name = nameParts.join(" ").trim();
	if (!isMemoryKind(rawKind) || !name || !content) {
		throw new GatewayFailure("invalid_arguments", "Use /memory add <type> <name> :: <content>.");
	}
	return { kind: rawKind, name, description: name, content };
}

function isMemoryKind(value: string | undefined): value is "user" | "feedback" | "project" | "reference" {
	return value === "user" || value === "feedback" || value === "project" || value === "reference";
}

function requiredCommandPattern(value: string): string {
	const pattern = value.trim();
	if (!pattern || pattern.length > 512 || pattern.includes("\0")) {
		throw new GatewayFailure("invalid_arguments", "Command pattern is invalid.");
	}
	return pattern;
}

function terminalStatus(
	state: "completed" | "failed" | "interrupted",
	active: ActiveTurn,
	text: string,
	message?: string,
): JsonObject {
	return {
		state,
		kind: state,
		text,
		terminal: true,
		client_turn_id: active.clientTurnId,
		turn_id: active.turnId ?? active.clientTurnId,
		...(message ? { message } : {}),
	};
}

function waitingStatus(
	state: "waiting_approval" | "waiting_clarification",
	active: ActiveTurn,
	text: string,
): JsonObject {
	return {
		state,
		kind: state,
		text,
		terminal: false,
		client_turn_id: active.clientTurnId,
		turn_id: active.turnId ?? active.clientTurnId,
	};
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberRecord(value: JsonObject): Readonly<Record<string, number>> {
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
	);
}

const SAFE_TOOL_METADATA_KEYS = new Set([
	"actualEndLine",
	"actualStartLine",
	"columns",
	"dedup",
	"effectiveLimit",
	"limitClamped",
	"nextOffset",
	"offset",
	"requestedLimit",
	"rows",
	"shownLines",
	"totalLines",
	"truncated",
]);

function safeToolMetadata(
	metadata: Readonly<Record<string, unknown>>,
	success: boolean,
): JsonObject {
	const safe: JsonObject = {};
	const mutation = projectMutationMetadata(metadata, success);
	if (mutation.path) safe.path = mutation.path;
	if (mutation.status) safe.status = mutation.status;
	if (mutation.matches !== undefined) safe.matches = mutation.matches;
	if (mutation.file_changes) safe.file_changes = mutation.file_changes;
	for (const [key, value] of Object.entries(metadata)) {
		if (key === "path" || key === "status" || key === "matches") continue;
		if (!SAFE_TOOL_METADATA_KEYS.has(key)) continue;
		if (typeof value === "boolean") safe[key] = value;
		if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
	}
	return safe;
}

function toolLifecycleId(callId: string, toolName: string): string {
	return callId || `builtin:${toolName}`.slice(0, 256);
}

function boundedDurationMs(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(86_400_000, Math.max(0, Math.round(value)));
}

function boundedString(value: string, limit: number): string {
	return value.slice(0, limit);
}
