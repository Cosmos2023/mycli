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
	type ShellLifecycleEvent,
} from "@mycli/core";
import type {
	PendingSessionApproval,
	QueueCoordinator,
	ResolveApprovalInput,
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
import type { ShellSessionSnapshot } from "@mycli/tools";
import type { GatewayTransport } from "mycli-shell-tui/gateway-transport";

type JsonObject = Record<string, unknown>;
type RpcId = string | number | null;

export interface NodeGatewayRuntime {
	readonly queueCoordinator?: QueueCoordinator;
	reserve(submission: TurnSubmission): TurnReservation;
	resolveApproval(
		input: ResolveApprovalInput,
		emit: (event: RuntimeEvent) => void,
		options: Pick<SubmitTurnOptions, "signal">,
	): Promise<RuntimeTurnRecord>;
	submit(
		submission: TurnSubmission,
		emit: (event: RuntimeEvent) => void,
		options: SubmitTurnOptions,
	): Promise<RuntimeTurnRecord>;
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
	readonly close: () => void | Promise<void>;
	readonly createTurnId?: () => string;
	readonly clock?: () => number;
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
	#trustState: WorkspaceTrustState;

	constructor(options: CreateNodeGatewayOptions) {
		this.#options = options;
		this.#clock = options.clock ?? (() => Date.now() / 1000);
		this.#trustState = options.workspaceTrust?.initialState ?? "unknown";
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
				return this.#status();
			case "workspace.trust.status":
				return this.#trustStatus();
			case "workspace.trust.set":
				return this.#setWorkspaceTrust(request.params);
			case "extension.manifest":
				return extensionManifest(this.#options.toolNames ?? []);
			case "session.bootstrap":
				return this.#bootstrap(request.params, true);
			case "transcript.load":
				return this.#transcript(request.params);
			case "command.list":
				return this.#commandList();
			case "command.run":
				return this.#commandRun(request.params);
			case "settings.load":
				return { settings: {}, source: "defaults" };
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
				return this.#approvalRespond(request.params);
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

	#bootstrap(params: JsonObject, reemitPendingApproval: boolean): JsonObject {
		if (params.protocol_version !== 1) {
			throw new GatewayFailure("incompatible_protocol", "Unsupported gateway protocol version.");
		}
		const payload: JsonObject = {
			protocol_version: 1,
			session_id: this.#sessionId(),
			workspace: this.#workspaceRoot(),
			provider: this.#options.provider,
			model: this.#options.model,
			status: this.#status(),
			background_shells: this.#activeShells().map((snapshot) =>
				shellSnapshotPayload(snapshot, this.#sessionContext())),
			auth_providers: [],
			models: [],
			permissions: {},
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
		if (reemitPendingApproval && session?.pendingApproval) {
			this.#emitRuntime(
				"approval.request",
				approvalRequest(session.pendingApproval, session.generation),
			);
		}
		return payload;
	}

	async #transcript(params: JsonObject): Promise<JsonObject> {
		const sessionId = optionalString(params.session_id) ?? this.#sessionId();
		if (this.#options.sessionCoordinator) {
			const prepared = await this.#options.sessionCoordinator.inspect(sessionId);
			const projected = prepared.transcript.map(gatewayTranscriptItem);
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
				read_only: prepared.readOnly,
			};
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

	#commandList(): JsonObject {
		return {
			commands: this.#options.shellManager ? [SHELL_PS_COMMAND] : [],
		};
	}

	async #commandRun(params: JsonObject): Promise<JsonObject> {
		const command = requiredString(params.command, "command").trim();
		if (command === "/ps") {
			const context = this.#sessionContext();
			const processes = this.#activeShells().map((snapshot) =>
				shellSnapshotPayload(snapshot, context));
			return shellPsCommandResult(processes);
		}
		if (command === "/stop") {
			const stopped = await this.#shellStopAll();
			return shellStopCommandResult(stopped);
		}
		throw new GatewayFailure("method_not_found", "Unknown command.");
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
		if (coordinator.snapshot().pendingApproval) {
			throw new GatewayFailure("turn_in_progress", "An approval continuation owns the session.");
		}
		const snapshot = await coordinator.resume(requiredString(params.session_id, "session_id"));
		this.#trustState = await this.#loadWorkspaceTrust(snapshot.workspaceRoot);
		this.#bindQueue();
		this.#emitDirect("session.changed", {
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
		});
		this.#emitRuntime("status.changed", this.#status());
		if (snapshot.pendingApproval) {
			this.#emitRuntime("approval.request", approvalRequest(snapshot.pendingApproval, snapshot.generation));
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
		if (this.#options.sessionCoordinator?.snapshot().pendingApproval) {
			throw new GatewayFailure("turn_in_progress", "An approval continuation owns the session.");
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
			turnId: this.#options.createTurnId?.()
				?? `turn_${randomUUID().replaceAll("-", "")}`,
			message,
			localImages,
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
		if (choice !== "approve_once" && choice !== "reject") {
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
			turnId: this.#options.createTurnId?.()
				?? `turn_${randomUUID().replaceAll("-", "")}`,
			message: record.text,
			localImages: record.imagePaths,
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
			provider: this.#options.provider,
			model: this.#options.model,
			context_window: {
				used_tokens: 0,
				max_tokens: this.#options.maxPromptTokens ?? 0,
				source: "unknown",
			},
			pending_decision: session?.pendingApproval !== undefined,
			suspended_turn: session?.suspendedTurn ?? false,
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
		};
	}

	#trustStatus(): JsonObject {
		return {
			state: this.#trustState,
			workspace: this.#workspaceRoot(),
			source: this.#options.workspaceTrust ? "user_store" : "runtime",
			enforced: false,
		};
	}

	async #setWorkspaceTrust(params: JsonObject): Promise<JsonObject> {
		const state = workspaceTrustState(params.state);
		await this.#options.workspaceTrust?.save(this.#workspaceRoot(), state);
		this.#trustState = state;
		const payload = this.#trustStatus();
		this.#emitRuntime("workspace.trust.changed", payload);
		this.#emitRuntime("status.changed", this.#status());
		return payload;
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

const SHELL_PS_COMMAND = Object.freeze({
	id: "ps",
	name: "/ps",
	description: "List background terminals",
	argument_policy: "none",
	available_during_turn: true,
});

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

function approvalChoiceLabel(choice: PendingSessionApproval["options"][number]): string {
	return {
		approve_once: "Approve once",
		reject: "Reject",
		allow_session: "Allow for session",
		always_allow: "Always allow",
	}[choice];
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

function extensionManifest(toolNames: readonly string[]): JsonObject {
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
	};
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new GatewayFailure("invalid_params", `${name} is required.`);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
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
				: state === "completed"
					? "Completed"
					: state === "interrupted"
						? "Interrupted"
						: "Failed",
		client_turn_id: clientTurnId,
		...(message ? { message } : {}),
	};
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
