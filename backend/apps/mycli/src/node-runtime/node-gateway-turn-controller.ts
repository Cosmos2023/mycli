import { randomUUID } from "node:crypto";
import {
	runtimeErrorPublicMessage,
	runtimeRetryStatusText,
	sanitizeRuntimeErrorDetail,
	type RuntimeErrorCode,
	type RuntimeTurnRecord,
} from "@mycli/contracts";
import type {
	ProviderUsage,
	QueueMutation,
	QueueSnapshot,
	QueuedInput,
	ReasoningEffort,
	RuntimeEvent,
	WebSearchAction,
} from "@mycli/core";
import type {
	PendingSessionApproval,
	PendingSessionClarification,
	QueueCoordinator,
	ResolveApprovalInput,
	ResolveClarificationInput,
	SessionCoordinator,
	SessionExecutionClaim,
	SessionGenerationContext,
	TurnSubmission,
} from "@mycli/runtime";
import { projectMutationMetadata } from "@mycli/storage";
import type { TurnReservation } from "@mycli/storage";
import {
	approvalPreviewDetails,
	approvalPreviewPayload,
	fileMutationChangesPayload,
} from "./approval-preview.ts";
import { GatewayFailure, gatewayFailure } from "./node-gateway-errors.ts";
import type {
	GatewayEventOwnership,
	RuntimeGatewayEventMethod,
} from "./node-gateway-event-projector.ts";
import {
	approvalRequestPayload,
	clarificationRequestPayload,
	isApprovalChoice,
} from "./node-gateway-interactive-controller.ts";
import {
	credentialReadinessPayload,
} from "./node-gateway-settings-controller.ts";
import type { AgentInteractiveRequestGateway } from "./agent-interactive-requests.ts";
import type {
	NodeGatewayCredentialReadiness,
	NodeGatewayRuntime,
	NodeGatewayTraceCommands,
} from "./node-gateway-types.ts";
import {
	extractProposedPlan,
	ProposedPlanStreamFilter,
} from "./proposed-plan.ts";

type JsonObject = Record<string, unknown>;

const GRACEFUL_INTERRUPT_TIMEOUT_MS = 100;

interface ActiveTurn {
	readonly clientTurnId: string;
	readonly clientUserMessageId: string;
	readonly controller: AbortController;
	readonly context: SessionGenerationContext;
	readonly runtime: NodeGatewayRuntime;
	readonly executionClaim?: SessionExecutionClaim;
	readonly collaborationMode: "default" | "plan";
	readonly planStreamFilter?: ProposedPlanStreamFilter;
	turnId?: string;
	terminalEmitted: boolean;
	terminalState?: "completed" | "failed" | "interrupted";
	visibleAgentOutput?: boolean;
	pendingProposedPlan?: string;
	inputRolledBack?: boolean;
	interruptionFinalizedLogged?: boolean;
	resubmitPendingSteersAfterInterrupt?: boolean;
	interruptedSteerClientIds?: readonly string[];
	failedSteersPrepared?: boolean;
	interruptPromise?: Promise<JsonObject>;
	forceInterruptPromise?: Promise<RuntimeTurnRecord>;
	contextWindow?: Readonly<{
		readonly usedTokens: number;
		readonly maxTokens: number;
		readonly source: "provider_live" | "runtime_estimate";
	}>;
}

export interface NodeGatewayTurnControllerOptions {
	readonly dependencies: NodeGatewayTurnDependencies;
	readonly session: NodeGatewayTurnSession;
	readonly settings: NodeGatewayTurnSettings;
	readonly isClosed: () => boolean;
	readonly status: () => JsonObject;
	readonly publish: (method: RuntimeGatewayEventMethod, params: JsonObject) => void;
}

export interface NodeGatewayTurnDependencies {
	readonly sessionCoordinator?: SessionCoordinator<NodeGatewayRuntime>;
	readonly agentInteractiveRequests?: Pick<
		AgentInteractiveRequestGateway,
		"respondApproval" | "respondClarification"
	>;
	readonly createTurnId?: () => string;
	readonly loadTurnRollouts?: (sessionId: string) => readonly JsonObject[];
	readonly maxPromptTokens?: number | (() => number);
	readonly traceCommands?: Pick<NodeGatewayTraceCommands, "append">;
}

export interface NodeGatewayTurnSession {
	readonly transitionActive: boolean;
	readonly controlActive: boolean;
	sessionId(): string;
	context(): SessionGenerationContext;
	isCurrent(context: SessionGenerationContext): boolean;
	runtime(): NodeGatewayRuntime;
	queueCoordinator(): QueueCoordinator | undefined;
	requiredQueueCoordinator(): QueueCoordinator;
	assertMutationContext(params: JsonObject): SessionGenerationContext;
}

export interface NodeGatewayTurnSettings {
	readonly model: string;
	readonly reasoningEffort: ReasoningEffort | undefined;
	readonly collaborationMode: "default" | "plan";
	credentialReadiness(): Promise<NodeGatewayCredentialReadiness | null>;
	ensureSessionPreferences(collaborationMode: "default" | "plan"): void;
	setCollaborationMode(mode: "default" | "plan", publish?: boolean): void;
	modeForTurn(turnId: string): "default" | "plan";
	rememberTurnMode(turnId: string, mode: "default" | "plan"): void;
	forgetTurnMode(turnId: string): void;
}

export class NodeGatewayTurnController {
	readonly #dependencies: NodeGatewayTurnDependencies;
	readonly #session: NodeGatewayTurnSession;
	readonly #settings: NodeGatewayTurnSettings;
	readonly #isClosed: () => boolean;
	readonly #status: () => JsonObject;
	readonly #publish: (method: RuntimeGatewayEventMethod, params: JsonObject) => void;
	#active: ActiveTurn | null = null;
	#activeTask: Promise<void> | null = null;
	#admissionPending = false;

	constructor(options: NodeGatewayTurnControllerOptions) {
		this.#dependencies = options.dependencies;
		this.#session = options.session;
		this.#settings = options.settings;
		this.#isClosed = options.isClosed;
		this.#status = options.status;
		this.#publish = options.publish;
	}

	hasActiveTurn(): boolean {
		return this.#active !== null;
	}

	isAdmissionPending(): boolean {
		return this.#admissionPending;
	}

	activeTurnId(): string | null {
		return this.#active?.turnId ?? null;
	}

	currentOwnership(params: Readonly<JsonObject>): GatewayEventOwnership {
		const context = this.#session.context();
		const requestedTurnId = typeof params.turn_id === "string" && params.turn_id
			? params.turn_id
			: undefined;
		const clientTurnId = typeof params.client_turn_id === "string"
			? params.client_turn_id
			: undefined;
		const activeTurnId = this.#active && clientTurnId === this.#active.clientTurnId
			? this.#active.turnId ?? this.#active.clientTurnId
			: undefined;
		return {
			sessionId: context.sessionId,
			generation: context.generation,
			...(requestedTurnId ?? activeTurnId
				? { turnId: requestedTurnId ?? activeTurnId }
				: {}),
		};
	}

	async close(): Promise<void> {
		this.#active?.controller.abort();
		await this.#activeTask;
	}

	publishRecoveredInterrupt(record: RuntimeTurnRecord, options: {
		readonly inputRolledBack?: boolean;
	} = {}): void {
		if (record.session_id !== this.#session.sessionId() || record.status !== "interrupted") {
			throw new Error("invalid_recovered_interrupt");
		}
		this.#publish("turn.interrupted", {
			client_turn_id: record.client_turn_id,
			turn_id: record.turn_id,
			code: "interrupted",
			requested: false,
			message: "Turn interrupted",
			input_rolled_back: options.inputRolledBack === true,
		});
		this.#publish("turn.status", {
			state: "interrupted",
			kind: "interrupted",
			text: "Interrupted",
			terminal: true,
			client_turn_id: record.client_turn_id,
			turn_id: record.turn_id,
			message: "Turn interrupted",
		});
		this.#publish("status.update", {
			...statusPayload("interrupted", record.client_turn_id, "Turn interrupted"),
			turn_id: record.turn_id,
		});
		this.#publish("status.changed", this.#status());
	}

	async submit(params: JsonObject): Promise<JsonObject> {
		if (
			this.#active !== null
			|| this.#admissionPending
			|| this.#session.transitionActive
			|| this.#session.controlActive
		) {
			throw new GatewayFailure("turn_in_progress", "A turn is already running.");
		}
		const context = this.#session.assertMutationContext(params);
		if (this.#dependencies.sessionCoordinator?.snapshot().pendingApproval
			|| this.#dependencies.sessionCoordinator?.snapshot().pendingClarification) {
			throw new GatewayFailure("turn_in_progress", "A pending continuation owns the session.");
		}
		if (this.#dependencies.sessionCoordinator?.snapshot().readOnly) {
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
		const collaborationMode = collaborationModeParameter(params.collaboration_mode)
			?? this.#settings.collaborationMode;
		const runtime = this.#session.runtime();
		const coordinator = this.#dependencies.sessionCoordinator;
		this.#admissionPending = true;
		const executionClaim = coordinator?.claimExecution(context);
		if (coordinator && !executionClaim) {
			this.#admissionPending = false;
			throw new GatewayFailure("turn_in_progress", "A session transition is in progress.");
		}
		let activeInstalled = false;
		try {
			const readiness = await this.#settings.credentialReadiness();
			if (readiness && !readiness.ready) {
				throw new GatewayFailure(
					"auth_required",
					"Provider credentials are required before starting a turn.",
					credentialReadinessPayload(readiness),
				);
			}
			this.#settings.ensureSessionPreferences(collaborationMode);
			const submission: TurnSubmission = {
				clientTurnId,
				clientUserMessageId,
				turnId: this.#dependencies.createTurnId?.()
					?? `turn_${randomUUID().replaceAll("-", "")}`,
				message,
				localImages,
				modelOverride: this.#settings.model,
				...(this.#settings.reasoningEffort
					? { reasoningEffort: this.#settings.reasoningEffort }
					: {}),
			};
			const reservation = runtime.reserve(submission);
			const turnId = reservation.turn.turn_id;
			const collaborationModeChanged = collaborationMode !== this.#settings.collaborationMode;
			if (collaborationModeChanged) {
				this.#settings.setCollaborationMode(collaborationMode, false);
			}
			this.#settings.rememberTurnMode(turnId, collaborationMode);
			runtime.configureRuntimeContext?.({ collaborationMode, turnId });
			const active: ActiveTurn = {
				clientTurnId,
				clientUserMessageId,
				controller: new AbortController(),
				context,
				runtime,
				...(executionClaim ? { executionClaim } : {}),
				collaborationMode,
				...(collaborationMode === "plan"
					? { planStreamFilter: new ProposedPlanStreamFilter() }
					: {}),
				turnId,
				terminalEmitted: false,
			};
			this.#emitUserMessageLifecycle(active, message, "submit");
			this.#active = active;
			activeInstalled = true;
			if (collaborationModeChanged) this.#publish("status.changed", this.#status());
			this.#activeTask = new Promise<void>((resolve) => {
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
		} catch (error) {
			if (!activeInstalled && executionClaim) coordinator?.releaseExecution(executionClaim);
			throw error;
		} finally {
			this.#admissionPending = false;
		}
	}

	respondApproval(params: JsonObject): JsonObject {
		const childResponse = this.#dependencies.agentInteractiveRequests?.respondApproval(params);
		if (childResponse) return childResponse;
		const coordinator = this.#dependencies.sessionCoordinator;
		if (!coordinator) {
			throw new GatewayFailure("approval_not_pending", "No pending approval is available.");
		}
		if (this.#active !== null) {
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
		const executionClaim = coordinator.claimExecution(context);
		if (!executionClaim) {
			throw new GatewayFailure("turn_in_progress", "A session transition is in progress.");
		}
		const collaborationMode = this.#settings.modeForTurn(pending.turnId);
		try {
			snapshot.binding.configureRuntimeContext?.({ collaborationMode, turnId: pending.turnId });
		} catch (error) {
			coordinator.releaseExecution(executionClaim);
			throw error;
		}
		const active: ActiveTurn = {
			clientTurnId: pending.clientTurnId,
			clientUserMessageId: pending.clientTurnId,
			controller: new AbortController(),
			context,
			runtime: snapshot.binding,
			executionClaim,
			collaborationMode,
			...(collaborationMode === "plan"
				? { planStreamFilter: new ProposedPlanStreamFilter() }
				: {}),
			turnId: pending.turnId,
			terminalEmitted: false,
		};
		this.#active = active;
		coordinator.updatePendingApproval(context, undefined);
		this.#publish("approval.respond", {
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
			decision_id: pending.decisionId,
			choice,
		});
		this.#publish("status.update", statusPayload("running", pending.clientTurnId));
		this.#activeTask = new Promise<void>((resolve) => {
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

	respondClarification(params: JsonObject): JsonObject {
		const childResponse = this.#dependencies.agentInteractiveRequests?.respondClarification(params);
		if (childResponse) return childResponse;
		const coordinator = this.#dependencies.sessionCoordinator;
		if (!coordinator) {
			throw new GatewayFailure(
				"clarification_not_pending",
				"No pending clarification is available.",
			);
		}
		if (this.#active !== null) {
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
		const requestedSessionId = optionalString(params.session_id);
		const requestedGeneration = params.generation === undefined
			? snapshot.generation
			: positiveInteger(params.generation);
		if (requestedGeneration === undefined) {
			throw new GatewayFailure("invalid_params", "generation must be a positive integer.");
		}
		if (response.length > 4_096) {
			throw new GatewayFailure("invalid_params", "response exceeds 4096 characters.");
		}
		if (
			requestId !== pending.requestId
			|| requestedSessionId !== undefined && requestedSessionId !== snapshot.sessionId
			|| requestedGeneration !== snapshot.generation
		) {
			throw new GatewayFailure(
				"clarification_not_pending",
				"No pending clarification matches the request.",
			);
		}
		const context = coordinator.context();
		const executionClaim = coordinator.claimExecution(context);
		if (!executionClaim) {
			throw new GatewayFailure("turn_in_progress", "A session transition is in progress.");
		}
		const collaborationMode = this.#settings.modeForTurn(pending.turnId);
		try {
			snapshot.binding.configureRuntimeContext?.({ collaborationMode, turnId: pending.turnId });
		} catch (error) {
			coordinator.releaseExecution(executionClaim);
			throw error;
		}
		const active: ActiveTurn = {
			clientTurnId: pending.clientTurnId,
			clientUserMessageId: pending.clientUserMessageId,
			controller: new AbortController(),
			context,
			runtime: snapshot.binding,
			executionClaim,
			collaborationMode,
			...(collaborationMode === "plan"
				? { planStreamFilter: new ProposedPlanStreamFilter() }
				: {}),
			turnId: pending.turnId,
			terminalEmitted: false,
		};
		this.#active = active;
		coordinator.updatePendingClarification(context, undefined);
		this.#publish("turn.started", {
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
		});
		this.#publish("status.update", statusPayload("running", pending.clientTurnId));
		this.#publish("clarify.respond", {
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
			request_id: pending.requestId,
			header: pending.header,
			question: pending.question,
			response: boundedString(response, 4_096),
			multi_select: pending.multiSelect,
		});
		this.#activeTask = new Promise<void>((resolve) => {
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

	steer(params: JsonObject): JsonObject {
		const context = this.#session.assertMutationContext(params);
		const queue = this.#session.requiredQueueCoordinator();
		const expectedTurnId = requiredString(params.expected_turn_id, "expected_turn_id");
		const active = this.#active;
		const mutation = queue.enqueueSteer({
			sessionId: context.sessionId,
			clientTurnId: queueClientTurnId(params, "steer"),
			expectedTurnId,
			activeTurnId: active?.turnId ?? null,
			steerable: active !== null && !active.controller.signal.aborted,
			text: requiredString(params.message, "message"),
			imagePaths: localImagePaths(params.local_images),
			source: "user",
		});
		if (this.#active === null) this.requestNextQueuedTurn();
		return queueMutationResponse(mutation, context);
	}

	followUp(params: JsonObject): JsonObject {
		const context = this.#session.assertMutationContext(params);
		const mutation = this.#session.requiredQueueCoordinator().enqueueFollowUp({
			sessionId: context.sessionId,
			clientTurnId: queueClientTurnId(params, "follow"),
			text: requiredString(params.message, "message"),
			imagePaths: localImagePaths(params.local_images),
			source: "user",
		});
		if (this.#active === null) this.requestNextQueuedTurn();
		return queueMutationResponse(mutation, context);
	}

	popQueue(params: JsonObject): JsonObject {
		const context = this.#session.assertMutationContext(params);
		const removal = this.#session.requiredQueueCoordinator().popLastFollowUp();
		return {
			session_id: context.sessionId,
			generation: context.generation,
			...queueProjection(removal.snapshot),
			item: removal.record ? gatewayQueueItem(removal.record) : null,
		};
	}

	clearQueue(params: JsonObject): JsonObject {
		const context = this.#session.assertMutationContext(params);
		const token = optionalBoundedIdentity(params.restore_token, "restore_token")
			?? `restore_${randomUUID().replaceAll("-", "")}`;
		const result = this.#session.requiredQueueCoordinator().claimForRestoration(token);
		const steering = result.records.filter((record) => record.kind === "pending_steer");
		const followUps = result.records.filter((record) => record.kind !== "pending_steer");
		return {
			session_id: context.sessionId,
			generation: context.generation,
			restore_token: result.token,
			...queueProjection(result.snapshot),
			steering: steering.map((record) => record.text),
			follow_up: followUps.map((record) => record.text),
			steering_items: steering.map(legacyQueueItem),
			follow_up_items: followUps.map(legacyQueueItem),
		};
	}

	acknowledgeQueueRestore(params: JsonObject): JsonObject {
		const context = this.#session.assertMutationContext(params);
		const token = requiredString(params.restore_token, "restore_token");
		const snapshot = this.#session.requiredQueueCoordinator().acknowledgeRestoration(token);
		return {
			acknowledged: true,
			restore_token: token,
			session_id: context.sessionId,
			generation: context.generation,
			...queueProjection(snapshot),
		};
	}

	acknowledgeQueueMigration(params: JsonObject): JsonObject {
		const token = requiredString(params.token, "token");
		const snapshot = this.#session.requiredQueueCoordinator().acknowledgeLegacyMigration(token);
		return { acknowledged: true, token, ...queueProjection(snapshot) };
	}

	requestNextQueuedTurn(): void {
		queueMicrotask(() => {
			if (!this.#isClosed()) this.#scheduleNextQueuedTurn();
		});
	}

	interrupt(params: JsonObject): JsonObject | Promise<JsonObject> {
		this.#session.assertMutationContext(params);
		let active = this.#active;
		const coordinator = this.#dependencies.sessionCoordinator;
		const pendingClarification = active
			? undefined
			: coordinator?.snapshot().pendingClarification;
		let actualTurnId: string;
		if (active) {
			actualTurnId = active.turnId ?? active.clientTurnId;
		} else if (pendingClarification) {
			actualTurnId = pendingClarification.turnId;
		} else {
			return { accepted: false, requested: false, ...this.#status() };
		}
		const expectedTurnId = requiredString(params.turn_id, "turn_id");
		if (expectedTurnId !== actualTurnId) {
			throw new GatewayFailure(
				"turn_id_mismatch",
				"The active turn changed before interruption.",
				{ actual_turn_id: actualTurnId },
			);
		}
		if (!active && pendingClarification && coordinator) {
			const context = this.#session.context();
			const executionClaim = coordinator.claimExecution(context);
			if (!executionClaim) {
				return { accepted: false, requested: false, ...this.#status() };
			}
			const runtime = this.#session.runtime();
			const collaborationMode = this.#settings.modeForTurn(pendingClarification.turnId);
			try {
				runtime.configureRuntimeContext?.({
					collaborationMode,
					turnId: pendingClarification.turnId,
				});
			} catch (error) {
				coordinator.releaseExecution(executionClaim);
				throw error;
			}
			active = {
				clientTurnId: pendingClarification.clientTurnId,
				clientUserMessageId: pendingClarification.clientUserMessageId,
				controller: new AbortController(),
				context,
				runtime,
				executionClaim,
				collaborationMode,
				turnId: pendingClarification.turnId,
				terminalEmitted: false,
				visibleAgentOutput: true,
			};
			this.#active = active;
		}
		if (!active) return { accepted: false, requested: false, ...this.#status() };
		if (active.interruptPromise) return active.interruptPromise;
		active.resubmitPendingSteersAfterInterrupt = this.#session.queueCoordinator()
			?.snapshot()
			.pendingSteers.some(
				(record) => record.targetTurnId === actualTurnId && record.source === "user",
			) === true;
		active.inputRolledBack = params.rollback_user_input === true
			&& active.visibleAgentOutput !== true;
		this.#appendInterruptTrace("turn_interrupt_requested", active, {
			requested: true,
			input_rolled_back: active.inputRolledBack === true,
		});
		active.controller.abort();
		active.interruptPromise = this.#awaitInterrupt(active);
		return active.interruptPromise;
	}

	async #runTurn(
		active: ActiveTurn,
		submission: TurnSubmission,
		reservation: TurnReservation,
	): Promise<void> {
		let terminalFinalized = false;
		try {
			const record = await active.runtime.submit(
				submission,
			(event) => { this.#acceptRuntimeEvent(active, event); },
				{ signal: active.controller.signal, reservation },
			);
			if (record.status === "interrupted") this.#recordInterruptFinalized(active);
			if (!active.terminalEmitted && this.#isCurrent(active)) {
				this.#projectStoredTerminal(active, record);
			}
			terminalFinalized = record.status !== "in_progress";
		} catch {
			if (active.controller.signal.aborted && !active.terminalEmitted) {
				try {
					const record = await this.#forceInterruptActive(active);
					this.#projectForcedInterrupt(active, record);
					terminalFinalized = record.status !== "in_progress";
				} catch {
					if (!active.terminalEmitted) {
						this.#emitTurnFailure(active, "persistence_error", "Session persistence failed.");
					}
				}
			} else if (!active.terminalEmitted) {
				this.#emitTurnFailure(active, "persistence_error", "Session persistence failed.");
			}
		} finally {
			this.#releaseActiveExecution(active, terminalFinalized);
		}
	}

	async #runApproval(
		active: ActiveTurn,
		input: ResolveApprovalInput,
		pending: PendingSessionApproval,
	): Promise<void> {
		let terminalFinalized = false;
		try {
			const record = await active.runtime.resolveApproval(
				input,
				(event) => { this.#acceptRuntimeEvent(active, event); },
				{ signal: active.controller.signal },
			);
			if (record.status === "interrupted") this.#recordInterruptFinalized(active);
			if (!active.terminalEmitted && this.#isCurrent(active)) {
				this.#projectStoredTerminal(active, record);
			}
			terminalFinalized = record.status !== "in_progress";
		} catch (error) {
			if (active.controller.signal.aborted) {
				try {
					const record = await this.#forceInterruptActive(active);
					this.#projectForcedInterrupt(active, record);
					terminalFinalized = record.status !== "in_progress";
				} catch {
					if (!active.terminalEmitted && this.#isCurrent(active)) {
						this.#emitTurnFailure(active, "persistence_error", "Session persistence failed.");
					}
				}
			} else {
				const restored = this.#dependencies.sessionCoordinator
					?.updatePendingApproval(active.context, pending);
				if (restored === false || active.terminalEmitted || !this.#isCurrent(active)) return;
				const failure = gatewayFailure(error);
				this.#publish("gateway.error", {
					code: failure.code === "persistence_error" ? "internal_error" : failure.code,
					message: failure.message,
					method: "approval.respond",
				});
				this.#publish(
					"approval.request",
					approvalRequestPayload(pending, active.context.generation),
				);
				this.#publish(
					"status.update",
					statusPayload("waiting_approval", active.clientTurnId),
				);
			}
		} finally {
			this.#releaseActiveExecution(active, terminalFinalized);
		}
	}

	async #runClarification(
		active: ActiveTurn,
		input: ResolveClarificationInput,
		pending: PendingSessionClarification,
	): Promise<void> {
		let terminalFinalized = false;
		try {
			const record = await active.runtime.resolveClarification(
				input,
				(event) => { this.#acceptRuntimeEvent(active, event); },
				{ signal: active.controller.signal },
			);
			if (record.status === "interrupted") this.#recordInterruptFinalized(active);
			if (!active.terminalEmitted && this.#isCurrent(active)) {
				this.#projectStoredTerminal(active, record);
			}
			terminalFinalized = record.status !== "in_progress";
		} catch (error) {
			if (active.controller.signal.aborted) {
				try {
					const record = await this.#forceInterruptActive(active);
					this.#projectForcedInterrupt(active, record);
					terminalFinalized = record.status !== "in_progress";
				} catch {
					if (!active.terminalEmitted && this.#isCurrent(active)) {
						this.#emitTurnFailure(active, "persistence_error", "Session persistence failed.");
					}
				}
			} else {
				const restored = this.#dependencies.sessionCoordinator
					?.updatePendingClarification(active.context, pending);
				if (restored === false || active.terminalEmitted || !this.#isCurrent(active)) return;
				const failure = gatewayFailure(error);
				this.#publish("gateway.error", {
					code: failure.code === "persistence_error" ? "internal_error" : failure.code,
					message: failure.message,
					method: "clarify.respond",
				});
				this.#publish(
					"clarify.request",
					clarificationRequestPayload(pending, active.context.generation),
				);
				this.#publish(
					"turn.status",
					waitingStatus("waiting_clarification", active, "Waiting clarification"),
				);
				this.#publish(
					"status.update",
					statusPayload("waiting_clarification", active.clientTurnId),
				);
			}
		} finally {
			this.#releaseActiveExecution(active, terminalFinalized);
		}
	}

	#releaseActiveExecution(active: ActiveTurn, terminalFinalized: boolean): void {
		if (this.#active !== active) return;
		if (active.executionClaim) {
			this.#dependencies.sessionCoordinator?.releaseExecution(active.executionClaim);
		}
		this.#active = null;
		this.#activeTask = null;
		if (this.#isClosed() || !this.#isCurrent(active)) return;
		this.#publish("status.changed", this.#status());
		this.#emitPendingProposedPlan(active);
		if (
			terminalFinalized
			&& (active.terminalState !== "interrupted"
				|| active.resubmitPendingSteersAfterInterrupt === undefined
				|| (active.interruptedSteerClientIds?.length ?? 0) > 0)
		) {
			this.#scheduleNextQueuedTurn();
		}
	}

	#scheduleNextQueuedTurn(): void {
		if (
			this.#active !== null
			|| this.#admissionPending
			|| this.#session.transitionActive
			|| this.#session.controlActive
		) return;
		const queue = this.#session.queueCoordinator();
		const record = queue?.next();
		if (!queue || !record) return;
		const context = this.#session.context();
		const runtime = this.#session.runtime();
		const coordinator = this.#dependencies.sessionCoordinator;
		const session = coordinator?.snapshot();
		if (session?.pendingApproval || session?.pendingClarification || session?.suspendedTurn) return;
		const executionClaim = coordinator?.claimExecution(context);
		if (coordinator && !executionClaim) return;
		let reservedTurnId: string;
		try {
			reservedTurnId = this.#dependencies.createTurnId?.()
				?? `turn_${randomUUID().replaceAll("-", "")}`;
		} catch {
			if (executionClaim) coordinator?.releaseExecution(executionClaim);
			this.#emitQueueWorkerStartFailed();
			return;
		}
		const proposed: TurnSubmission = {
			clientTurnId: record.clientTurnId,
			clientUserMessageId: record.clientTurnId,
			queueId: record.queueId,
			inputSource: record.kind === "rejected_steer" ? "steer" : "submit",
			turnId: reservedTurnId,
			message: record.text,
			localImages: record.imagePaths,
			modelOverride: this.#settings.model,
			...(this.#settings.reasoningEffort
				? { reasoningEffort: this.#settings.reasoningEffort }
				: {}),
		};
		let reservation: TurnReservation;
		let claimed = false;
		try {
			queue.claim(record.queueId, reservedTurnId);
			claimed = true;
			reservation = runtime.reserve(proposed);
			if (reservation.kind === "existing") {
				const reconciliation = queue.reconcileClaim(record.queueId, reservedTurnId);
				claimed = false;
				if (executionClaim) coordinator?.releaseExecution(executionClaim);
				if (reconciliation.committed) this.requestNextQueuedTurn();
				else this.#emitQueueWorkerStartFailed();
				return;
			}
			runtime.configureRuntimeContext?.({
				collaborationMode: this.#settings.collaborationMode,
				turnId: reservation.turn.turn_id,
			});
			try {
				queue.retireClaim(record.queueId, reservedTurnId);
				claimed = false;
			} catch {
				const reconciliation = queue.reconcileClaim(record.queueId, reservedTurnId);
				claimed = false;
				if (!reconciliation.committed) {
					throw new Error("queued turn reservation was not committed");
				}
			}
		} catch {
			if (claimed) {
				try {
					queue.reconcileClaim(record.queueId, reservedTurnId);
				} catch {
					// The durable claim remains recoverable on the next runtime load.
				}
			}
			if (executionClaim) coordinator?.releaseExecution(executionClaim);
			this.#emitQueueWorkerStartFailed();
			return;
		}
		const submission: TurnSubmission = {
			...proposed,
			turnId: reservation.turn.turn_id,
		};
		const collaborationMode = this.#settings.collaborationMode;
		this.#settings.rememberTurnMode(reservation.turn.turn_id, collaborationMode);
		const active: ActiveTurn = {
			clientTurnId: submission.clientTurnId,
			clientUserMessageId: submission.clientTurnId,
			controller: new AbortController(),
			context,
			runtime,
			...(executionClaim ? { executionClaim } : {}),
			collaborationMode,
			...(collaborationMode === "plan"
				? { planStreamFilter: new ProposedPlanStreamFilter() }
				: {}),
			turnId: reservation.turn.turn_id,
			terminalEmitted: false,
		};
		this.#emitUserMessageLifecycle(
			active,
			record.text,
			record.kind === "rejected_steer" ? "steer" : "submit",
			`${reservation.turn.turn_id}:queue:${record.queueId}`,
		);
		this.#active = active;
		this.#activeTask = new Promise<void>((resolve) => {
			queueMicrotask(() => {
				void this.#runTurn(active, submission, reservation).then(resolve);
			});
		});
	}

	#emitQueueWorkerStartFailed(): void {
		this.#publish("gateway.error", {
			code: "queue_worker_start_failed",
			message: "Queued turn could not be reserved.",
			method: "turn.submit",
		});
	}

	async #awaitInterrupt(active: ActiveTurn): Promise<JsonObject> {
		const task = this.#activeTask;
		const settledGracefully = task
			? await settlesWithin(task, GRACEFUL_INTERRUPT_TIMEOUT_MS)
			: active.terminalEmitted;
		if (!settledGracefully && this.#ownsActiveTurn(active) && !active.terminalEmitted) {
			const record = await this.#forceInterruptActive(active);
			this.#projectForcedInterrupt(active, record);
			const pendingClarification = this.#dependencies.sessionCoordinator
				?.snapshot().pendingClarification;
			if (pendingClarification?.turnId === active.turnId) {
				this.#dependencies.sessionCoordinator
					?.updatePendingClarification(active.context, undefined);
			}
			this.#releaseActiveExecution(active, record.status !== "in_progress");
		}
		const interrupted = active.terminalState === "interrupted";
		return {
			accepted: interrupted,
			requested: interrupted,
			client_turn_id: active.clientTurnId,
			turn_id: active.turnId ?? active.clientTurnId,
			input_rolled_back: interrupted && active.inputRolledBack === true,
			...(active.interruptedSteerClientIds?.length
				? {
					pending_steers_resubmitted: true,
					resubmitted_client_user_message_ids: [...active.interruptedSteerClientIds],
				}
				: {}),
			...(!interrupted ? this.#status() : {}),
		};
	}

	#forceInterruptActive(active: ActiveTurn): Promise<RuntimeTurnRecord> {
		active.forceInterruptPromise ??= active.runtime.forceInterrupt(
			{
				clientTurnId: active.clientTurnId,
				turnId: active.turnId ?? active.clientTurnId,
			},
			(event) => {
				if (this.#ownsActiveTurn(active)) this.#handleRuntimeEvent(active, event);
			},
		);
		return active.forceInterruptPromise;
	}

	#projectForcedInterrupt(active: ActiveTurn, record: RuntimeTurnRecord): void {
		if (record.status === "interrupted") this.#recordInterruptFinalized(active);
		if (!active.terminalEmitted && this.#ownsActiveTurn(active)) {
			this.#projectStoredTerminal(active, record);
		}
	}

	#handleRuntimeEvent(active: ActiveTurn, event: RuntimeEvent): void {
		switch (event.type) {
			case "turn_started":
				active.turnId = event.turnId;
				this.#publish("turn.started", {
					client_turn_id: event.clientTurnId,
					turn_id: event.turnId,
				});
				this.#publish("status.update", statusPayload("running", active.clientTurnId));
				this.#publish("status.changed", this.#status());
				break;
			case "user_message_started":
			case "user_message_completed":
				this.#publish(
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
				active.contextWindow = Object.freeze({
					usedTokens: event.beforeTokens,
					maxTokens: event.maxTokens,
					source: "runtime_estimate",
				});
				this.#publish("compaction.started", {
					client_turn_id: event.clientTurnId,
					source: event.source,
					before_tokens: event.beforeTokens,
					max_tokens: event.maxTokens,
				});
				this.#publish("status.changed", this.#status());
				break;
			case "compaction_completed":
				active.contextWindow = Object.freeze({
					usedTokens: event.afterTokens,
					maxTokens: event.maxTokens,
					source: "runtime_estimate",
				});
				this.#publish("compaction.completed", {
					client_turn_id: event.clientTurnId,
					source: event.source,
					status: event.status,
					before_tokens: event.beforeTokens,
					after_tokens: event.afterTokens,
					max_tokens: event.maxTokens,
					duration_s: event.durationSeconds,
				});
				this.#publish("status.changed", this.#status());
				break;
			case "text_delta":
				if (event.text.length > 0) active.visibleAgentOutput = true;
				this.#emitAssistantDelta(
					active,
					active.planStreamFilter?.push(event.text) ?? event.text,
				);
				break;
			case "reasoning_delta": {
				if (event.text.length > 0) active.visibleAgentOutput = true;
				const payload = { client_turn_id: active.clientTurnId, text: event.text };
				this.#publish("reasoning.delta", payload);
				this.#publish("thinking.delta", payload);
				this.#emitTurnEvent(active, "reasoning", "reasoning", event.text);
				break;
			}
			case "provider_usage":
				active.contextWindow = contextWindowFromUsage(
					event.usage,
					this.#configuredMaxPromptTokens(),
					"provider_live",
				);
				this.#publish("status.changed", this.#status());
				break;
			case "stream_retrying":
				if (event.resetOutput) {
					active.planStreamFilter?.reset();
					this.#publish("message.reset", {
						client_turn_id: active.clientTurnId,
					});
				}
				this.#publish("stream.retrying", {
					client_turn_id: active.clientTurnId,
					text: runtimeRetryStatusText(event.failureKind, event.attempt, event.maxRetries),
					attempt: event.attempt,
					max_retries: Math.max(event.maxRetries, event.attempt),
					delay_seconds: event.delayMs / 1000,
					recovery_kind: event.recoveryKind,
					failure_kind: event.failureKind,
					additional_details: sanitizeRuntimeErrorDetail(event.additionalDetails)
						?? runtimeErrorPublicMessage(event.failureKind),
				});
				break;
			case "stream_recovered":
				this.#publish("stream.recovered", { client_turn_id: active.clientTurnId });
				break;
			case "message_complete":
				this.#emitAssistantDelta(active, active.planStreamFilter?.finishSegment() ?? "");
				this.#publish("message.complete", { client_turn_id: active.clientTurnId });
				this.#emitTurnEvent(active, "model_completed", "completed", "", {
					...(event.responseId ? { response_id: event.responseId } : {}),
				});
				break;
			case "web_search_started": {
				active.visibleAgentOutput = true;
				const callId = boundedString(event.callId, 256);
				this.#publish("item.started", {
					client_turn_id: active.clientTurnId,
					turn_id: active.turnId ?? active.clientTurnId,
					item: {
						id: webSearchLifecycleId(callId),
						type: "web_search",
						call_id: callId,
					},
				});
				this.#publish("status.update", statusPayload("running", active.clientTurnId));
				break;
			}
			case "web_search_completed": {
				active.visibleAgentOutput = true;
				const callId = boundedString(event.call.callId, 256);
				this.#publish("item.completed", {
					client_turn_id: active.clientTurnId,
					turn_id: active.turnId ?? active.clientTurnId,
					item: {
						id: webSearchLifecycleId(callId),
						type: "web_search",
						call_id: callId,
						status: "completed",
						action: event.call.action,
						detail: webSearchActionDetail(event.call.action),
					},
				});
				this.#publish("status.update", statusPayload("running", active.clientTurnId));
				break;
			}
			case "tool_call_accepted":
				break;
			case "file_mutation_started": {
				active.visibleAgentOutput = true;
				const callId = boundedString(event.callId, 256);
				const toolName = boundedString(event.toolName, 128) || "Tool";
				this.#publish("item.started", {
					client_turn_id: event.clientTurnId,
					turn_id: event.turnId,
					item: {
						id: toolLifecycleId(callId, toolName),
						type: "file_change",
						call_id: callId,
						name: toolName,
						preview: boundedString(event.preview, 512) || toolName,
						...approvalPreviewPayload(event),
						...fileMutationChangesPayload(event.fileChanges),
					},
				});
				break;
			}
			case "approval_requested": {
				active.visibleAgentOutput = true;
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
					...(event.permissionRequest ? {
						permissionRequest: event.permissionRequest,
					} : {}),
					...approvalPreviewDetails(event),
				};
				if (this.#dependencies.sessionCoordinator
					?.updatePendingApproval(active.context, approval) === false) {
					break;
				}
				this.#publish(
					"approval.request",
					approvalRequestPayload(approval, active.context.generation),
				);
				this.#publish(
					"status.update",
					statusPayload("waiting_approval", active.clientTurnId),
				);
				break;
			}
			case "clarification_requested": {
				active.visibleAgentOutput = true;
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
				if (this.#dependencies.sessionCoordinator
					?.updatePendingClarification(active.context, clarification) === false) {
					break;
				}
				this.#publish(
					"clarify.request",
					clarificationRequestPayload(clarification, active.context.generation),
				);
				this.#publish(
					"turn.status",
					waitingStatus("waiting_clarification", active, "Waiting clarification"),
				);
				this.#publish(
					"status.update",
					statusPayload("waiting_clarification", active.clientTurnId),
				);
				break;
			}
			case "tool_execution_started": {
				active.visibleAgentOutput = true;
				const callId = boundedString(event.callId, 256);
				const toolName = boundedString(event.toolName, 128) || "Tool";
				this.#publish("tool.start", {
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
			case "plan_updated": {
				const completed = event.items.filter((item) => item.status === "completed").length;
				this.#publish("plan.updated", {
					client_turn_id: active.clientTurnId,
					plan_steps: event.items.map((item) => `${item.status}: ${item.text}`),
					plan: { items: event.items },
					source: "update_plan",
					completed,
					total: event.items.length,
					...(event.explanation ? { explanation: event.explanation } : {}),
				});
				break;
			}
			case "turn_completed":
				if (active.terminalEmitted) {
					if (active.controller.signal.aborted) {
						this.#publish("turn.completion_suppressed", {
							client_turn_id: active.clientTurnId,
							reason: "interrupt_requested",
							suppressed_state: "completed",
						});
					}
					break;
				}
				active.terminalEmitted = true;
				if (active.controller.signal.aborted) {
					this.#publish("turn.completion_suppressed", {
						client_turn_id: active.clientTurnId,
						reason: "interrupt_requested",
						suppressed_state: "completed",
					});
					this.#emitInterrupted(active);
				} else {
					this.#emitCompleted(active, event.assistantText, event.usage, event.durationMs);
				}
				break;
			case "turn_failed":
				if (active.terminalEmitted) break;
				active.terminalEmitted = true;
				this.#emitTurnFailure(active, event.code, event.message, event.additionalDetails);
				break;
			case "turn_interrupted":
				this.#recordInterruptFinalized(active);
				if (active.terminalEmitted) break;
				active.terminalEmitted = true;
				this.#emitInterrupted(active);
				break;
		}
	}

	#emitAssistantDelta(active: ActiveTurn, text: string): void {
		if (!text) return;
		this.#publish("message.delta", {
			client_turn_id: active.clientTurnId,
			text,
		});
		this.#emitTurnEvent(active, "assistant_delta", "text_delta", text);
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
		this.#publish(method, {
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

	contextWindow(): JsonObject {
		const live = this.#active?.contextWindow;
		if (live) {
			return contextWindowPayload(live.usedTokens, live.maxTokens, live.source);
		}
		const rollouts = this.#dependencies.loadTurnRollouts?.(this.#session.sessionId()) ?? [];
		let usage: JsonObject | undefined;
		let source = "unknown";
		for (let index = rollouts.length - 1; index >= 0; index -= 1) {
			const rollout = rollouts[index];
			const continuation = rollout && isObject(rollout.continuation_state)
				? rollout.continuation_state
				: undefined;
			if (!continuation) continue;
			if (isObject(continuation.last_token_usage)) {
				usage = continuation.last_token_usage;
				source = this.#active ? "provider_previous" : "provider";
				break;
			}
			if (!isObject(continuation.usage)) continue;
			usage = continuation.usage;
			source = this.#active ? "provider_previous" : "provider_aggregate";
			break;
		}
		const inputTokens = nonNegativeMetric(usage?.input_tokens);
		const totalTokens = nonNegativeMetric(usage?.total_tokens);
		const usedTokens = inputTokens > 0 ? inputTokens : totalTokens;
		return contextWindowPayload(usedTokens, this.#configuredMaxPromptTokens(), source);
	}

	#projectStoredTerminal(active: ActiveTurn, record: RuntimeTurnRecord): void {
		active.terminalEmitted = true;
		active.turnId ??= record.turn_id;
		if (record.status === "completed") {
			const result = isObject(record.result) ? record.result : {};
			this.#emitCompleted(
				active,
				typeof result.assistant_text === "string" ? result.assistant_text : "",
				isObject(result.usage) ? numberRecord(result.usage) : {},
				completedTurnDurationMs(record),
			);
		} else if (record.status === "interrupted") {
			this.#emitInterrupted(active);
		} else if (record.status === "failed") {
			const result = isObject(record.result) ? record.result : {};
			this.#emitTurnFailure(
				active,
				record.error_code ?? "provider_error",
				typeof result.message === "string" ? result.message : "Turn failed.",
				typeof result.additional_details === "string" ? result.additional_details : undefined,
			);
		}
	}

	#emitCompleted(
		active: ActiveTurn,
		assistantText: string,
		usage: Readonly<Record<string, number>>,
		durationMs?: number,
	): void {
		active.terminalState = "completed";
		const turnId = active.turnId ?? active.clientTurnId;
		this.#emitAssistantDelta(active, active.planStreamFilter?.finishSegment() ?? "");
		const proposedPlan = active.collaborationMode === "plan"
			? extractProposedPlan(assistantText)
			: undefined;
		const visibleAssistantText = proposedPlan?.assistantText ?? assistantText;
		this.#publish("turn.completed", {
			client_turn_id: active.clientTurnId,
			turn_id: turnId,
			assistant_message: visibleAssistantText,
			activity_events: [],
			progress_updates: [],
			plan_steps: [],
			pending_decision: false,
			turn_state: "completed",
			usage,
			...(durationMs === undefined ? {} : { duration_ms: boundedDurationMs(durationMs) }),
		});
		this.#publish("turn.status", terminalStatus("completed", active, "Completed"));
		this.#publish("message.complete", {
			client_turn_id: active.clientTurnId,
			text: visibleAssistantText,
			final: true,
			source: "turn_response",
		});
		if (proposedPlan) {
			active.visibleAgentOutput = true;
			active.pendingProposedPlan = proposedPlan.planText;
		}
		this.#settings.forgetTurnMode(turnId);
		this.#publish("status.update", statusPayload("completed", active.clientTurnId));
	}

	#emitPendingProposedPlan(active: ActiveTurn): void {
		const text = active.pendingProposedPlan;
		if (!text) return;
		delete active.pendingProposedPlan;
		this.#publish("plan.proposed", {
			client_turn_id: active.clientTurnId,
			text,
			source: "assistant_message",
		});
	}

	#emitTurnFailure(
		active: ActiveTurn,
		code: RuntimeErrorCode,
		message: string,
		additionalDetails?: string,
	): void {
		this.#prepareFailedSteers(active);
		active.terminalState = "failed";
		this.#settings.forgetTurnMode(active.turnId ?? active.clientTurnId);
		const safeAdditionalDetails = sanitizeRuntimeErrorDetail(additionalDetails);
		this.#publish("turn.failed", {
			client_turn_id: active.clientTurnId,
			turn_id: active.turnId ?? active.clientTurnId,
			code,
			message,
			...(safeAdditionalDetails ? { additional_details: safeAdditionalDetails } : {}),
		});
		this.#publish("turn.status", terminalStatus("failed", active, "Failed"));
		this.#publish("status.update", statusPayload("failed", active.clientTurnId));
	}

	#emitInterrupted(active: ActiveTurn): void {
		active.terminalState = "interrupted";
		this.#prepareInterruptedSteers(active);
		this.#settings.forgetTurnMode(active.turnId ?? active.clientTurnId);
		this.#publish("turn.interrupted", {
			client_turn_id: active.clientTurnId,
			turn_id: active.turnId ?? active.clientTurnId,
			code: "interrupted",
			requested: false,
			message: "Turn interrupted",
			input_rolled_back: active.inputRolledBack === true,
		});
		this.#publish(
			"turn.status",
			terminalStatus("interrupted", active, "Interrupted", "Turn interrupted"),
		);
		this.#publish(
			"status.update",
			statusPayload("interrupted", active.clientTurnId, "Turn interrupted"),
		);
	}

	#prepareInterruptedSteers(active: ActiveTurn): void {
		if (active.interruptedSteerClientIds !== undefined) return;
		active.interruptedSteerClientIds = Object.freeze([]);
		if (!active.resubmitPendingSteersAfterInterrupt || !active.turnId) return;
		try {
			const result = this.#session.queueCoordinator()?.prepareInterruptedSteers(active.turnId);
			active.interruptedSteerClientIds = Object.freeze(
				(result?.records ?? []).map((record) => record.clientTurnId),
			);
		} catch {
			this.#publish("gateway.error", {
				code: "queue_worker_start_failed",
				message: "Queued steer could not be prepared after interruption.",
				method: "turn.interrupt",
			});
		}
	}

	#prepareFailedSteers(active: ActiveTurn): void {
		if (active.failedSteersPrepared || !active.turnId) return;
		active.failedSteersPrepared = true;
		try {
			this.#session.queueCoordinator()?.rejectPending(active.turnId);
		} catch {
			this.#publish("gateway.error", {
				code: "queue_worker_start_failed",
				message: "Queued steer could not be deferred after turn failure.",
				method: "turn.submit",
			});
		}
	}

	#appendInterruptTrace(
		kind: "turn_interrupt_requested" | "turn_interrupted",
		active: ActiveTurn,
		payload: JsonObject,
	): void {
		try {
			this.#dependencies.traceCommands?.append?.(this.#session.sessionId(), {
				kind,
				turn_id: active.turnId ?? active.clientTurnId,
				payload: {
					client_turn_id: active.clientTurnId,
					...payload,
				},
			});
		} catch {
			// Diagnostics must not block interruption.
		}
	}

	#recordInterruptFinalized(active: ActiveTurn): void {
		if (active.interruptionFinalizedLogged) return;
		active.interruptionFinalizedLogged = true;
		this.#appendInterruptTrace("turn_interrupted", active, { status: "interrupted" });
	}

	#configuredMaxPromptTokens(): number {
		const configured = typeof this.#dependencies.maxPromptTokens === "function"
			? this.#dependencies.maxPromptTokens()
			: this.#dependencies.maxPromptTokens;
		return nonNegativeMetric(configured);
	}

	#isCurrent(active: ActiveTurn): boolean {
		return this.#session.isCurrent(active.context);
	}

	#ownsActiveTurn(active: ActiveTurn): boolean {
		return this.#active === active && this.#isCurrent(active);
	}

	#acceptRuntimeEvent(active: ActiveTurn, event: RuntimeEvent): void {
		if (this.#ownsActiveTurn(active)) {
			this.#handleRuntimeEvent(active, event);
			return;
		}
		if (
			active.terminalState === "interrupted"
			&& event.type === "turn_completed"
			&& this.#isCurrent(active)
		) {
			this.#publish("turn.completion_suppressed", {
				client_turn_id: active.clientTurnId,
				reason: "interrupt_requested",
				suppressed_state: "completed",
			});
		}
	}

	#emitTurnEvent(
		active: ActiveTurn,
		phase: string,
		kind: string,
		text: string,
		metadata: JsonObject = {},
		toolName: string | null = null,
	): void {
		this.#publish("turn.event", {
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
		itemId?: string,
	): void {
		const turnId = active.turnId ?? active.clientTurnId;
		const params = {
			client_turn_id: active.clientTurnId,
			turn_id: turnId,
			item: {
				id: itemId ?? `${turnId}:user:${active.clientUserMessageId}`,
				type: "user_message",
				client_user_message_id: active.clientUserMessageId,
				content,
				source,
			},
		};
		this.#publish("item.started", params);
		this.#publish("item.completed", params);
	}
}

export function gatewayQueueItem(item: QueuedInput): JsonObject {
	return {
		queue_id: item.queueId,
		session_id: item.sessionId,
		client_turn_id: item.clientTurnId,
		target_turn_id: item.targetTurnId,
		kind: item.kind,
		state: item.state,
		claim_turn_id: item.claimTurnId ?? null,
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

export function queueEventPayload(
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

export function queueProjection(snapshot: QueueSnapshot): JsonObject {
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

export function legacyMigrationRecord(item: QueuedInput): JsonObject {
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

function queueMutationResponse(
	mutation: QueueMutation,
	context: SessionGenerationContext,
): JsonObject {
	return {
		accepted: true,
		session_id: context.sessionId,
		generation: context.generation,
		disposition: mutation.disposition,
		record: gatewayQueueItem(mutation.record),
		...queueProjection(mutation.snapshot),
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

function isVisibleQueueItem(item: QueuedInput): boolean {
	return item.source !== "task_notification" && item.source !== "agent_mailbox";
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

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new GatewayFailure("invalid_params", `${name} is required.`);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalBoundedIdentity(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") {
		throw new GatewayFailure("invalid_params", `${name} must be a string.`);
	}
	const normalized = value.trim();
	if (!normalized || normalized.length > 512 || /[\r\n\0]/u.test(normalized)) {
		throw new GatewayFailure("invalid_params", `${name} is invalid.`);
	}
	return normalized;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

function stringArray(value: unknown, name: string): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new GatewayFailure("invalid_params", `${name} must be an array of strings.`);
	}
	return value;
}

function collaborationModeParameter(value: unknown): "default" | "plan" | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (value === "default" || value === "plan") return value;
	throw new GatewayFailure(
		"invalid_params",
		"collaboration_mode must be default or plan.",
	);
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

function contextWindowFromUsage(
	usage: ProviderUsage,
	maxTokens: number,
	source: "provider_live",
): NonNullable<ActiveTurn["contextWindow"]> {
	const inputTokens = nonNegativeMetric(usage.input_tokens ?? usage.inputTokens);
	const totalTokens = nonNegativeMetric(usage.total_tokens ?? usage.totalTokens);
	return Object.freeze({
		usedTokens: inputTokens > 0 ? inputTokens : totalTokens,
		maxTokens,
		source,
	});
}

function contextWindowPayload(usedTokens: number, maxTokens: number, source: string): JsonObject {
	return {
		used_tokens: usedTokens,
		max_tokens: maxTokens,
		usage_ratio: maxTokens > 0 ? usedTokens / maxTokens : 0,
		source,
	};
}

function nonNegativeMetric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
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
	const skillName = skillNameFromMetadata(metadata);
	if (skillName) safe.skill_name = skillName;
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

function skillNameFromMetadata(metadata: Readonly<Record<string, unknown>>): string | undefined {
	if (!isObject(metadata.skillInvocationArtifact)) return undefined;
	const name = metadata.skillInvocationArtifact.name;
	return typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(name)
		? name
		: undefined;
}

function toolLifecycleId(callId: string, toolName: string): string {
	return callId || `builtin:${toolName}`.slice(0, 256);
}

function webSearchLifecycleId(callId: string): string {
	return `web-search:${callId}`;
}

function webSearchActionDetail(action: WebSearchAction): string {
	switch (action.type) {
		case "search": {
			const query = action.query ?? action.queries?.[0] ?? "";
			return !action.query && (action.queries?.length ?? 0) > 1 && query
				? `${query} ...`
				: query;
		}
		case "open_page":
			return action.url ?? "";
		case "find_in_page":
			return action.pattern && action.url
				? `'${action.pattern}' in ${action.url}`
				: action.pattern
					? `'${action.pattern}'`
					: action.url ?? "";
		case "other":
			return "";
	}
}

function boundedDurationMs(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(86_400_000, Math.max(0, Math.round(value)));
}

function completedTurnDurationMs(turn: RuntimeTurnRecord): number | undefined {
	if (turn.completed_at === null) return undefined;
	const startedAt = Date.parse(turn.started_at);
	const completedAt = Date.parse(turn.completed_at);
	if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
		return undefined;
	}
	return boundedDurationMs(completedAt - startedAt);
}

async function settlesWithin(task: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			task.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function boundedString(value: string, limit: number): string {
	return value.slice(0, limit);
}
