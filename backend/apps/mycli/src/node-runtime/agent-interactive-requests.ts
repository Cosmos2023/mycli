import type { RuntimeTurnRecord } from "@mycli/contracts";
import type {
	ApprovalChoice,
	RuntimeEvent,
} from "@mycli/core";
import type { ChildRuntimeEvent } from "@mycli/integrations";
import type {
	ResolveApprovalInput,
	ResolveClarificationInput,
	SubmitTurnOptions,
} from "@mycli/runtime";
import { permissionRequestJson } from "@mycli/tools";
import { approvalPreviewPayload } from "./approval-preview.ts";

type JsonObject = Record<string, unknown>;

export interface AgentInteractiveRuntime {
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
}

export interface AgentInteractiveNotification {
	readonly method:
		| "approval.request"
		| "approval.respond"
		| "clarify.request"
		| "clarify.respond"
		| "interactive.cancelled";
	readonly params: JsonObject;
}

export interface AgentInteractiveRequestSnapshot {
	readonly sessionId: string;
	readonly generation: number;
	readonly agentPath: string;
	readonly workerName: string;
	readonly kind: "approval" | "clarification";
	readonly clientTurnId: string;
	readonly turnId: string;
	readonly requestId: string;
	readonly toolName: string;
}

export interface AgentInteractiveRequestGateway {
	subscribe(listener: (notification: AgentInteractiveNotification) => void): () => void;
	pending(): readonly AgentInteractiveRequestSnapshot[];
	respondApproval(params: JsonObject): JsonObject | undefined;
	respondClarification(params: JsonObject): JsonObject | undefined;
}

export interface OpenAgentInteractiveTurnInput {
	readonly sessionId: string;
	readonly agentPath: string;
	readonly workerName: string;
	readonly runtime: AgentInteractiveRuntime;
	readonly signal: AbortSignal;
	readonly emitLifecycle: (event: ChildRuntimeEvent) => void;
	readonly emitRuntime: (event: RuntimeEvent) => void;
}

export interface AgentInteractiveTurn {
	onRuntimeEvent(event: RuntimeEvent): void;
	waitForTerminal(result: RuntimeTurnRecord): Promise<RuntimeTurnRecord>;
	fail(error: unknown): void;
}

type ApprovalRequest = Extract<RuntimeEvent, { readonly type: "approval_requested" }>;
type ClarificationRequest = Extract<RuntimeEvent, { readonly type: "clarification_requested" }>;

type PendingRequest = Readonly<{
	sessionId: string;
	generation: number;
	agentPath: string;
	workerName: string;
	turn: InteractiveTurn;
	event: ApprovalRequest | ClarificationRequest;
}>;

export class AgentInteractiveRequestBroker implements AgentInteractiveRequestGateway {
	readonly #listeners = new Set<(notification: AgentInteractiveNotification) => void>();
	readonly #pendingBySession = new Map<string, PendingRequest>();
	#generation = 0;

	openTurn(input: OpenAgentInteractiveTurnInput): AgentInteractiveTurn {
		this.#generation += 1;
		return new InteractiveTurn(this, input, this.#generation);
	}

	subscribe(listener: (notification: AgentInteractiveNotification) => void): () => void {
		this.#listeners.add(listener);
		for (const pending of this.#pendingBySession.values()) {
			this.#notifyListener(listener, requestNotification(pending));
		}
		return () => { this.#listeners.delete(listener); };
	}

	pending(): readonly AgentInteractiveRequestSnapshot[] {
		return Object.freeze([...this.#pendingBySession.values()].map(pendingSnapshot));
	}

	respondApproval(params: JsonObject): JsonObject | undefined {
		const sessionId = optionalString(params.session_id);
		if (!sessionId) return undefined;
		const pending = this.#pendingBySession.get(sessionId);
		if (!pending) return undefined;
		if (pending.event.type !== "approval_requested") {
			throw requestFailure("approval_not_pending", "No pending approval matches the request.");
		}
		validateGeneration(params.generation, pending.generation, "approval_not_pending");
		const decisionId = requiredString(params.decision_id, "decision_id");
		if (decisionId !== pending.event.decisionId) {
			throw requestFailure("approval_not_pending", "No pending approval matches the request.");
		}
		const choice = requiredString(params.choice, "choice");
		if (!isApprovalChoice(choice) || !pending.event.options.includes(choice)) {
			throw requestFailure("invalid_params", "Unsupported approval choice.");
		}
		this.#consume(pending, {
			method: "approval.respond",
			params: {
				session_id: pending.sessionId,
				generation: pending.generation,
				client_turn_id: pending.event.clientTurnId,
				decision_id: pending.event.decisionId,
				choice,
			},
		});
		pending.turn.resumeApproval({ decisionId, choice });
		return {
			accepted: true,
			decision_id: pending.event.decisionId,
			client_turn_id: pending.event.clientTurnId,
			turn_id: pending.event.turnId,
			session_id: pending.sessionId,
			generation: pending.generation,
		};
	}

	respondClarification(params: JsonObject): JsonObject | undefined {
		const sessionId = optionalString(params.session_id);
		if (!sessionId) return undefined;
		const pending = this.#pendingBySession.get(sessionId);
		if (!pending) return undefined;
		if (pending.event.type !== "clarification_requested") {
			throw requestFailure(
				"clarification_not_pending",
				"No pending clarification matches the request.",
			);
		}
		validateGeneration(params.generation, pending.generation, "clarification_not_pending");
		const requestId = requiredString(params.request_id, "request_id");
		if (requestId !== pending.event.requestId) {
			throw requestFailure(
				"clarification_not_pending",
				"No pending clarification matches the request.",
			);
		}
		const response = requiredString(params.response, "response").trim();
		if (!response) throw requestFailure("invalid_params", "response must not be empty.");
		if (response.length > 4_096) {
			throw requestFailure("invalid_params", "response exceeds 4096 characters.");
		}
		this.#consume(pending, {
			method: "clarify.respond",
			params: {
				session_id: pending.sessionId,
				generation: pending.generation,
				client_turn_id: pending.event.clientTurnId,
				turn_id: pending.event.turnId,
				request_id: pending.event.requestId,
				header: pending.event.header,
				question: pending.event.question,
				response,
				multi_select: pending.event.multiSelect,
			},
		});
		pending.turn.resumeClarification({ requestId, response });
		return {
			accepted: true,
			request_id: pending.event.requestId,
			client_turn_id: pending.event.clientTurnId,
			turn_id: pending.event.turnId,
			session_id: pending.sessionId,
			generation: pending.generation,
		};
	}

	register(turn: InteractiveTurn, event: ApprovalRequest | ClarificationRequest): void {
		const existing = this.#pendingBySession.get(turn.sessionId);
		if (existing) throw new Error("agent_interactive_request_already_pending");
		const pending = Object.freeze({
			sessionId: turn.sessionId,
			generation: turn.generation,
			agentPath: turn.agentPath,
			workerName: turn.workerName,
			turn,
			event,
		});
		this.#pendingBySession.set(turn.sessionId, pending);
		this.#notify(requestNotification(pending));
	}

	remove(turn: InteractiveTurn): void {
		const pending = this.#pendingBySession.get(turn.sessionId);
		if (!pending || pending.turn !== turn) return;
		this.#pendingBySession.delete(turn.sessionId);
		this.#notify(cancelNotification(pending));
	}

	#consume(pending: PendingRequest, notification: AgentInteractiveNotification): void {
		this.#pendingBySession.delete(pending.sessionId);
		this.#notify(notification);
	}

	#notify(notification: AgentInteractiveNotification): void {
		for (const listener of this.#listeners) {
			this.#notifyListener(listener, notification);
		}
	}

	#notifyListener(
		listener: (notification: AgentInteractiveNotification) => void,
		notification: AgentInteractiveNotification,
	): void {
		try {
			listener(notification);
		} catch {
			// UI projection listeners cannot affect child execution.
		}
	}
}

class InteractiveTurn implements AgentInteractiveTurn {
	readonly #broker: AgentInteractiveRequestBroker;
	readonly #input: OpenAgentInteractiveTurnInput;
	readonly #terminal: Promise<RuntimeTurnRecord>;
	readonly #resolveTerminal: (result: RuntimeTurnRecord) => void;
	readonly #rejectTerminal: (error: unknown) => void;
	#settled = false;
	#waiting = false;
	#continuationActive = false;

	constructor(
		broker: AgentInteractiveRequestBroker,
		input: OpenAgentInteractiveTurnInput,
		readonly generation: number,
	) {
		this.#broker = broker;
		this.#input = input;
		let resolveTerminal!: (result: RuntimeTurnRecord) => void;
		let rejectTerminal!: (error: unknown) => void;
		this.#terminal = new Promise<RuntimeTurnRecord>((resolve, reject) => {
			resolveTerminal = resolve;
			rejectTerminal = reject;
		});
		void this.#terminal.catch(() => undefined);
		this.#resolveTerminal = resolveTerminal;
		this.#rejectTerminal = rejectTerminal;
		input.signal.addEventListener("abort", this.#onAbort, { once: true });
		if (input.signal.aborted) this.#onAbort();
	}

	get sessionId(): string { return this.#input.sessionId; }
	get agentPath(): string { return this.#input.agentPath; }
	get workerName(): string { return this.#input.workerName; }

	onRuntimeEvent(event: RuntimeEvent): void {
		this.#input.emitRuntime(event);
		if (event.type !== "approval_requested" && event.type !== "clarification_requested") return;
		this.#waiting = true;
		this.#broker.register(this, event);
		this.#input.emitLifecycle({
			type: "waiting",
			reason: event.type === "approval_requested" ? "approval" : "clarification",
			summary: event.type === "approval_requested"
				? `Waiting for approval: ${event.toolName}`
				: "Waiting for clarification",
		});
	}

	async waitForTerminal(result: RuntimeTurnRecord): Promise<RuntimeTurnRecord> {
		if (this.#settled) return this.#terminal;
		if (result.status !== "in_progress") {
			this.#complete(result);
		} else if (!this.#waiting && !this.#continuationActive) {
			this.fail(new Error("child_runtime_suspended_without_interactive_request"));
		}
		return this.#terminal;
	}

	resumeApproval(input: ResolveApprovalInput): void {
		this.#resume(
			() => this.#input.runtime.resolveApproval(input, (event) => this.onRuntimeEvent(event), {
				signal: this.#input.signal,
			}),
			"Child approval resolved",
		);
	}

	resumeClarification(input: ResolveClarificationInput): void {
		this.#resume(
			() => this.#input.runtime.resolveClarification(input, (event) => this.onRuntimeEvent(event), {
				signal: this.#input.signal,
			}),
			"Child clarification resolved",
		);
	}

	fail(error: unknown): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#broker.remove(this);
		this.#input.signal.removeEventListener("abort", this.#onAbort);
		this.#rejectTerminal(error);
	}

	readonly #onAbort = (): void => {
		const error = new Error("interrupted");
		error.name = "AbortError";
		this.fail(error);
	};

	#resume(run: () => Promise<RuntimeTurnRecord>, summary: string): void {
		if (this.#settled) return;
		this.#waiting = false;
		this.#continuationActive = true;
		this.#input.emitLifecycle({ type: "resumed", summary });
		void run().then(
			(result) => {
				this.#continuationActive = false;
				if (result.status !== "in_progress") this.#complete(result);
				else if (!this.#waiting) {
					this.fail(new Error("child_runtime_suspended_without_interactive_request"));
				}
			},
			(error: unknown) => {
				this.#continuationActive = false;
				this.fail(error);
			},
		);
	}

	#complete(result: RuntimeTurnRecord): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#broker.remove(this);
		this.#input.signal.removeEventListener("abort", this.#onAbort);
		this.#resolveTerminal(result);
	}
}

function requestNotification(pending: PendingRequest): AgentInteractiveNotification {
	const event = pending.event;
	const identity = {
		session_id: pending.sessionId,
		child_session_id: pending.sessionId,
		generation: pending.generation,
		agent_path: pending.agentPath,
		worker_name: pending.workerName,
		client_turn_id: event.clientTurnId,
		turn_id: event.turnId,
	};
	if (event.type === "approval_requested") {
		return {
			method: "approval.request",
			params: {
				...identity,
				decision_id: event.decisionId,
				call_id: event.callId,
				preview: event.preview,
				reason: event.reason,
				tool_name: event.toolName,
				action: event.toolName,
				...approvalPreviewPayload(event),
				...(event.permissionRequest ? {
					permission_request: permissionRequestJson(event.permissionRequest),
				} : {}),
				options: event.options.map((choice) => ({
					choice,
					label: approvalChoiceLabel(choice),
				})),
			},
		};
	}
	return {
		method: "clarify.request",
		params: {
			...identity,
			request_id: event.requestId,
			tool_id: event.callId,
			call_id: event.callId,
			tool_name: event.toolName,
			question: event.question,
			options: event.options.map((option) => ({ ...option })),
			header: event.header,
			multi_select: event.multiSelect,
		},
	};
}

function cancelNotification(pending: PendingRequest): AgentInteractiveNotification {
	const event = pending.event;
	return {
		method: "interactive.cancelled",
		params: {
			session_id: pending.sessionId,
			child_session_id: pending.sessionId,
			generation: pending.generation,
			client_turn_id: event.clientTurnId,
			turn_id: event.turnId,
			...(event.type === "approval_requested"
				? { decision_id: event.decisionId }
				: { request_id: event.requestId }),
		},
	};
}

function pendingSnapshot(pending: PendingRequest): AgentInteractiveRequestSnapshot {
	const event = pending.event;
	return Object.freeze({
		sessionId: pending.sessionId,
		generation: pending.generation,
		agentPath: pending.agentPath,
		workerName: pending.workerName,
		kind: event.type === "approval_requested" ? "approval" : "clarification",
		clientTurnId: event.clientTurnId,
		turnId: event.turnId,
		requestId: event.type === "approval_requested" ? event.decisionId : event.requestId,
		toolName: event.toolName,
	});
}

function approvalChoiceLabel(choice: ApprovalChoice): string {
	return {
		approve_once: "Approve once",
		reject: "Reject",
		allow_session: "Allow for session",
		always_allow: "Always allow",
	}[choice];
}

function isApprovalChoice(value: string): value is ApprovalChoice {
	return value === "approve_once"
		|| value === "reject"
		|| value === "allow_session"
		|| value === "always_allow";
}

function validateGeneration(
	value: unknown,
	expected: number,
	code: "approval_not_pending" | "clarification_not_pending",
): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || (value as number) !== expected) {
		throw requestFailure(code, "No pending interactive request matches the generation.");
	}
}

function requiredString(value: unknown, name: string): string {
	const result = optionalString(value);
	if (result) return result;
	throw requestFailure("invalid_params", `${name} must be a non-empty string.`);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requestFailure(code: string, message: string): Error & { readonly code: string } {
	return Object.assign(new Error(message), { code });
}
