import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
	gatewayContractCatalog,
	parseGatewayEvent,
	parseJsonRpcMessage,
} from "@mycli/contracts";
import type { RuntimeErrorCode, RuntimeTurnRecord } from "@mycli/contracts";
import {
	type CanonicalMessage,
	type RuntimeEvent,
} from "@mycli/core";
import type {
	NoToolSubmission,
	SubmitTurnOptions,
} from "@mycli/runtime";
import type { TurnReservation } from "@mycli/storage";
import type { GatewayTransport } from "mycli-shell-tui/gateway-transport";

type JsonObject = Record<string, unknown>;
type RpcId = string | number | null;

export interface NodeGatewayRuntime {
	reserve(submission: NoToolSubmission): TurnReservation;
	submit(
		submission: NoToolSubmission,
		emit: (event: RuntimeEvent) => void,
		options: SubmitTurnOptions,
	): Promise<RuntimeTurnRecord>;
}

export interface CreateNodeGatewayOptions {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly provider: string;
	readonly model: string;
	readonly maxPromptTokens?: number;
	readonly runtime: NodeGatewayRuntime;
	readonly loadConversation: (sessionId: string) => readonly CanonicalMessage[];
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

	constructor(options: CreateNodeGatewayOptions) {
		this.#options = options;
		this.#clock = options.clock ?? (() => Date.now() / 1000);
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
		this.#emitDirect("runtime.ready", { session_id: options.sessionId });
	}

	close(): Promise<void> {
		this.#closePromise ??= (async () => {
			if (this.#closed) return;
			this.#closed = true;
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
			this.#writeResult(request.id, result);
			if (request.method === "shutdown") {
				queueMicrotask(() => { void this.close(); });
			}
		} catch (error) {
			const failure = gatewayFailure(error);
			this.#writeError(request.id, failure.code, failure.message);
			this.#emitRuntime("gateway.error", {
				code: failure.code,
				message: failure.message,
				method: request.method,
			});
		}
	}

	#handleRequest(request: RpcRequest): JsonObject {
		switch (request.method) {
			case "initialize":
				return this.#bootstrap({ protocol_version: request.params.protocol_version ?? 1 });
			case "status.get":
				return this.#status();
			case "extension.manifest":
				return extensionManifest();
			case "session.bootstrap":
				return this.#bootstrap(request.params);
			case "transcript.load":
				return this.#transcript(request.params);
			case "command.list":
				return { commands: [] };
			case "settings.load":
				return { settings: {}, source: "defaults" };
			case "session.list":
				return {
					sessions: [{
						id: this.#options.sessionId,
						workspace: this.#options.workspaceRoot,
						cwd: this.#options.workspaceRoot,
						current: true,
					}],
				};
			case "turn.submit":
				return this.#submit(request.params);
			case "turn.interrupt":
				return this.#interrupt();
			case "shutdown":
				return { ok: true };
			default:
				throw new GatewayFailure("method_not_found", "Unknown gateway method.");
		}
	}

	#bootstrap(params: JsonObject): JsonObject {
		if (params.protocol_version !== 1) {
			throw new GatewayFailure("incompatible_protocol", "Unsupported gateway protocol version.");
		}
		return {
			protocol_version: 1,
			session_id: this.#options.sessionId,
			workspace: this.#options.workspaceRoot,
			provider: this.#options.provider,
			model: this.#options.model,
			status: this.#status(),
			background_shells: [],
			auth_providers: [],
			models: [],
			permissions: {},
			welcome: {
				startup_mark: { text: "mycli" },
				workspace: this.#options.workspaceRoot,
			},
		};
	}

	#transcript(params: JsonObject): JsonObject {
		const sessionId = optionalString(params.session_id) ?? this.#options.sessionId;
		if (sessionId !== this.#options.sessionId) {
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

	#submit(params: JsonObject): JsonObject {
		if (this.#activeTurn !== null) {
			throw new GatewayFailure("turn_in_progress", "A turn is already running.");
		}
		const message = requiredString(params.message, "message");
		const clientTurnId = requiredString(params.client_turn_id, "client_turn_id");
		const clientUserMessageId = requiredString(
			params.client_user_message_id,
			"client_user_message_id",
		);
		const localImages = stringArray(params.local_images, "local_images");
		const submission: NoToolSubmission = {
			clientTurnId,
			turnId: this.#options.createTurnId?.()
				?? `turn_${randomUUID().replaceAll("-", "")}`,
			message,
			localImages,
		};
		const reservation = this.#options.runtime.reserve(submission);
		const turnId = reservation.turn.turn_id;
		const active: ActiveTurn = {
			clientTurnId,
			clientUserMessageId,
			controller: new AbortController(),
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

	async #runTurn(
		active: ActiveTurn,
		submission: NoToolSubmission,
		reservation: TurnReservation,
	): Promise<void> {
		try {
			const record = await this.#options.runtime.submit(
				submission,
				(event) => { this.#projectRuntimeEvent(active, event); },
				{ signal: active.controller.signal, reservation },
			);
			if (!active.terminalEmitted) {
				this.#projectStoredTerminal(active, record);
			}
		} catch {
			if (!active.terminalEmitted) {
				this.#emitTurnFailure(active, "persistence_error", "Session persistence failed.");
			}
		} finally {
			if (this.#activeTurn === active) {
				this.#activeTurn = null;
				this.#activeTurnTask = null;
			}
			if (!this.#closed) this.#emitRuntime("status.changed", this.#status());
		}
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
		return {
			session_id: this.#options.sessionId,
			workspace: this.#options.workspaceRoot,
			provider: this.#options.provider,
			model: this.#options.model,
			context_window: {
				used_tokens: 0,
				max_tokens: this.#options.maxPromptTokens ?? 0,
				source: "unknown",
			},
			pending_decision: false,
			suspended_turn: false,
			turn_running: this.#activeTurn !== null,
			turn_id: this.#activeTurn?.turnId ?? null,
			queued_steering: [],
			queued_follow_up: [],
			has_pending_input: false,
			queue_activity: {
				kind: "idle",
				has_pending_input: false,
				steering_count: 0,
				follow_up_count: 0,
			},
			queue_revision: 0,
			queue_items: {
				pending_steers: [],
				rejected_steers: [],
				follow_ups: [],
			},
		};
	}

	#emitTurnEvent(
		active: ActiveTurn,
		phase: string,
		kind: string,
		text: string,
		metadata: JsonObject = {},
	): void {
		this.#emitRuntime("turn.event", {
			client_turn_id: active.clientTurnId,
			phase,
			kind,
			text,
			tool_name: null,
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

class GatewayFailure extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

function gatewayFailure(error: unknown): GatewayFailure {
	if (error instanceof GatewayFailure) return error;
	if (isObject(error) && error.code === "message_id_conflict") {
		return new GatewayFailure(
			"message_id_conflict",
			"client_turn_id already has a different payload.",
		);
	}
	if (isObject(error) && error.code === "persistence_error") {
		return new GatewayFailure("persistence_error", "Session persistence failed.");
	}
	return new GatewayFailure("internal_error", "Gateway request failed.");
}

function extensionManifest(): JsonObject {
	return {
		schema_version: 1,
		agent: { name: "mycli", version: "0.1.0", runtime: "node" },
		rpc_methods: gatewayContractCatalog.rpcMethods.map((name) => ({ name })),
		event_streams: gatewayContractCatalog.eventStreams.map((name) => ({ name })),
		capabilities: { no_tool_turns: true, tools: false },
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
		text: state === "running" ? "Running" : state === "completed" ? "Completed" : state === "interrupted" ? "Interrupted" : "Failed",
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
