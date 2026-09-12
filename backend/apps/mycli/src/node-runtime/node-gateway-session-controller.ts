import type {
	QueueSnapshot,
} from "@mycli/core";
import type {
	QueueCoordinator,
	SessionCoordinator,
	SessionGenerationContext,
} from "@mycli/runtime";
import type { PermissionProfile } from "@mycli/tools";
import { GatewayFailure, gatewayFailure } from "./node-gateway-errors.ts";
import {
	optionalBoundedIdentity,
	requiredBoundedString as requiredString,
} from "./node-gateway-validation.ts";
import {
	approvalRequestPayload,
	clarificationRequestPayload,
} from "./node-gateway-interactive-controller.ts";
import type {
	GatewayEventMethod,
	RuntimeGatewayEventMethod,
} from "./node-gateway-event-projector.ts";
import { credentialReadinessPayload } from "./node-gateway-settings-controller.ts";
import type {
	NodeGatewayCredentialReadiness,
	NodeGatewayRuntime,
	NodeGatewaySessionCommands,
} from "./node-gateway-types.ts";
import type {
	ResumeRepairAction,
	ResumeRepairPreview,
	SessionQuery,
	SessionSummary,
} from "./session-service.ts";

type JsonObject = Record<string, unknown>;
type SessionSnapshot = ReturnType<SessionCoordinator<NodeGatewayRuntime>["snapshot"]>;

interface SessionAdmissionClaim {
	readonly kind: "transition" | "control";
	readonly identity: object;
}

type SessionAdmissionState =
	| { readonly kind: "idle" }
	| { readonly kind: "transitioning"; readonly claim: SessionAdmissionClaim }
	| { readonly kind: "controlling"; readonly claim: SessionAdmissionClaim };

interface NodeGatewaySessionControllerOptions {
	readonly initialSessionId: string;
	readonly initialWorkspaceRoot: string;
	readonly initialRuntime: NodeGatewayRuntime;
	readonly coordinator?: SessionCoordinator<NodeGatewayRuntime>;
	readonly commands?: NodeGatewaySessionCommands;
	readonly isClosed: () => boolean;
	readonly hasActiveTurn: () => boolean;
	readonly isTurnAdmissionPending: () => boolean;
	readonly hasPendingInteractiveRequest: () => boolean;
	readonly hasPendingAgentRequest: () => boolean;
	readonly onTransition?: () => void;
	readonly activateSettings: (workspaceRoot: string, runtime: NodeGatewayRuntime) => Promise<void>;
	readonly activeShellPayloads: () => readonly JsonObject[];
	readonly authProviders: () => Promise<readonly JsonObject[]>;
	readonly credentialReadiness: () => Promise<NodeGatewayCredentialReadiness | null>;
	readonly status: () => JsonObject;
	readonly queuePayload: (
		snapshot: QueueSnapshot,
		context: SessionGenerationContext,
	) => JsonObject;
	readonly publish: (method: RuntimeGatewayEventMethod, params: JsonObject) => void;
	readonly publishDirect: (method: GatewayEventMethod, params: JsonObject) => void;
	readonly requestNextQueuedTurn: () => void;
}

export class NodeGatewaySessionController {
	readonly #options: NodeGatewaySessionControllerOptions;
	#admission: SessionAdmissionState = Object.freeze({ kind: "idle" });
	#unsubscribeQueue: (() => void) | null = null;

	constructor(options: NodeGatewaySessionControllerOptions) {
		this.#options = options;
	}

	get transitionActive(): boolean {
		return this.#admission.kind === "transitioning";
	}

	get controlActive(): boolean {
		return this.#admission.kind === "controlling";
	}

	close(): void {
		this.#unsubscribeQueue?.();
		this.#unsubscribeQueue = null;
	}

	sessionId(): string {
		return this.#options.coordinator?.snapshot().sessionId ?? this.#options.initialSessionId;
	}

	workspaceRoot(): string {
		return this.#options.coordinator?.snapshot().workspaceRoot
			?? this.#options.initialWorkspaceRoot;
	}

	runtime(): NodeGatewayRuntime {
		return this.#options.coordinator?.snapshot().binding ?? this.#options.initialRuntime;
	}

	context(): SessionGenerationContext {
		return this.#options.coordinator?.context()
			?? Object.freeze({ sessionId: this.#options.initialSessionId, generation: 1 });
	}

	isCurrent(context: SessionGenerationContext): boolean {
		return this.#options.coordinator?.isCurrent(context) ?? true;
	}

	queueCoordinator(): QueueCoordinator | undefined {
		return this.runtime().queueCoordinator;
	}

	requiredQueueCoordinator(): QueueCoordinator {
		const queue = this.queueCoordinator();
		if (!queue) throw new GatewayFailure("method_not_found", "Queue operations are unavailable.");
		return queue;
	}

	assertMutationContext(params: JsonObject): SessionGenerationContext {
		const context = this.context();
		const requestedSessionId = optionalBoundedIdentity(params.session_id, "session_id")
			?? context.sessionId;
		const requestedGeneration = params.generation === undefined
			? context.generation
			: positiveInteger(params.generation);
		if (requestedGeneration === undefined) {
			throw new GatewayFailure("invalid_params", "generation must be a positive integer.");
		}
		if (
			this.transitionActive
			|| requestedSessionId !== context.sessionId
			|| requestedGeneration !== context.generation
		) {
			throw new GatewayFailure(
				"session_changed",
				"The active session changed before queued input could be updated.",
				{
					active_session_id: context.sessionId,
					active_generation: context.generation,
				},
			);
		}
		return context;
	}

	claimControl(message: string): () => void {
		const coordinator = this.#options.coordinator;
		if (
			this.#admission.kind !== "idle"
			|| this.#options.isTurnAdmissionPending()
			|| this.#options.hasActiveTurn()
			|| coordinator?.executing()
		) {
			throw new GatewayFailure("turn_in_progress", message);
		}
		const claim: SessionAdmissionClaim = Object.freeze({ kind: "control", identity: {} });
		this.#admission = Object.freeze({ kind: "controlling", claim });
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (this.#admission.kind !== "controlling" || this.#admission.claim !== claim) return;
			this.#admission = Object.freeze({ kind: "idle" });
			this.#options.requestNextQueuedTurn();
		};
	}

	list(params: JsonObject = {}): JsonObject {
		const coordinator = this.#options.coordinator;
		if (!coordinator) {
			return {
				sessions: [{
					id: this.sessionId(),
					workspace: this.workspaceRoot(),
					cwd: this.workspaceRoot(),
					current: true,
				}],
			};
		}
		const activeSessionId = coordinator.snapshot().sessionId;
		const serviceSessions = this.#options.commands?.list?.(sessionQueryFromParams(params));
		const sessions: JsonObject[] = serviceSessions
			? serviceSessions.map((item) => sessionSummaryPayload(item, activeSessionId))
			: coordinator.listSessions({ limit: 20 }).map((item) => ({
				id: item.sessionId,
				workspace: item.workspaceRoot,
				cwd: item.workspaceRoot,
				created: item.createdAt,
				updated: item.updatedAt,
				last_active: item.lastActiveAt,
				modified: item.lastActiveAt,
				message_count: item.messageCount,
				current: item.sessionId === activeSessionId,
			}));
		if (!serviceSessions && !sessions.some((item) => item.id === activeSessionId)) {
			sessions.unshift({
				id: activeSessionId,
				workspace: coordinator.snapshot().workspaceRoot,
				cwd: coordinator.snapshot().workspaceRoot,
				current: true,
			});
		}
		return { sessions };
	}

	async startNew(): Promise<JsonObject> {
		const coordinator = this.#requiredCoordinator("New session creation is unavailable.");
		const claim = this.#claimTransition(coordinator);
		let activated = false;
		try {
			const snapshot = await coordinator.startNew();
			await this.#activate(snapshot);
			activated = true;
			return await this.#transitionPayload(snapshot);
		} finally {
			this.#releaseTransition(claim);
			if (activated) this.#options.requestNextQueuedTurn();
		}
	}

	async resume(params: JsonObject): Promise<JsonObject> {
		const coordinator = this.#requiredCoordinator("Session resume is unavailable.");
		const claim = this.#claimTransition(coordinator);
		let activated = false;
		try {
			let sessionId = requiredString(params.session_id, "session_id");
			const previewResume = this.#options.commands?.previewResume;
			if (previewResume) {
				let preview: ResumeRepairPreview | undefined;
				try {
					preview = await previewResume(sessionId);
				} catch (error) {
					if (gatewayFailure(error).code !== "session_not_found") throw error;
				}
				if (preview && !preview.ready) {
					const action = optionalString(params.repair_action);
					const revision = integerValue(params.metadata_revision);
					const applyRepair = this.#options.commands?.applyResumeRepair;
					if (!action || revision === undefined || !applyRepair) {
						throw new GatewayFailure(
							"session_repair_required",
							"Review the session recovery options before resuming.",
							{ preview: resumeRepairPreviewPayload(preview) },
						);
					}
					if (!isResumeRepairAction(action)) {
						throw new GatewayFailure("invalid_params", "Unknown session repair action.");
					}
					const repaired = await applyRepair({
						sessionId,
						expectedMetadataRevision: revision,
						action,
					});
					sessionId = repaired.sessionId;
					const repairedPreview = resumePreviewAfterConfirmedAction(
						await previewResume(sessionId),
						action,
					);
					if (!repairedPreview.ready) {
						throw new GatewayFailure(
							"session_repair_required",
							"Review the remaining session recovery options before resuming.",
							{ preview: resumeRepairPreviewPayload(repairedPreview) },
						);
					}
				}
			}
			const snapshot = await coordinator.resume(sessionId);
			await this.#activate(snapshot);
			activated = true;
			return await this.#transitionPayload(snapshot);
		} finally {
			this.#releaseTransition(claim);
			if (activated) this.#options.requestNextQueuedTurn();
		}
	}

	async previewResume(params: JsonObject): Promise<JsonObject> {
		const previewResume = this.#options.commands?.previewResume;
		if (!previewResume) {
			throw new GatewayFailure("method_not_found", "Session recovery preview is unavailable.");
		}
		return resumeRepairPreviewPayload(await previewResume(
			requiredString(params.session_id, "session_id"),
		));
	}

	tree(params: JsonObject): JsonObject {
		const coordinator = this.#options.coordinator;
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

	bindQueue(): void {
		this.#unsubscribeQueue?.();
		this.#unsubscribeQueue = null;
		const queue = this.queueCoordinator();
		if (!queue) return;
		const context = this.context();
		this.#unsubscribeQueue = queue.subscribe((snapshot) => {
			if (this.#options.isClosed()) return;
			const coordinator = this.#options.coordinator;
			if (coordinator) {
				if (!coordinator.updateQueue(context, snapshot)) return;
			} else if (snapshot.sessionId !== context.sessionId) {
				return;
			}
			this.#options.publish("turn.queue.updated", this.#options.queuePayload(snapshot, context));
		});
	}

	#claimTransition(
		coordinator: SessionCoordinator<NodeGatewayRuntime>,
	): SessionAdmissionClaim {
		this.#assertTransitionAvailable(coordinator);
		const claim: SessionAdmissionClaim = Object.freeze({ kind: "transition", identity: {} });
		this.#admission = Object.freeze({ kind: "transitioning", claim });
		this.#options.onTransition?.();
		return claim;
	}

	#releaseTransition(claim: SessionAdmissionClaim): void {
		if (this.#admission.kind !== "transitioning" || this.#admission.claim !== claim) return;
		this.#admission = Object.freeze({ kind: "idle" });
	}

	#assertTransitionAvailable(coordinator: SessionCoordinator<NodeGatewayRuntime>): void {
		if (
			this.#admission.kind !== "idle"
			|| this.#options.isTurnAdmissionPending()
			|| this.#options.hasActiveTurn()
			|| coordinator.executing()
		) {
			throw new GatewayFailure("turn_in_progress", "A turn is already running.");
		}
		const snapshot = coordinator.snapshot();
		if (snapshot.pendingApproval || snapshot.pendingClarification) {
			throw new GatewayFailure("turn_in_progress", "A pending continuation owns the session.");
		}
		if (this.#options.hasPendingAgentRequest() || this.#options.hasPendingInteractiveRequest()) {
			throw new GatewayFailure("turn_in_progress", "A pending agent request owns the terminal.");
		}
	}

	async #activate(snapshot: SessionSnapshot): Promise<void> {
		await this.#options.activateSettings(snapshot.workspaceRoot, snapshot.binding);
		const queue = snapshot.binding.queueCoordinator;
		if (queue) {
			const released = queue.releaseRestorationClaims();
			this.#options.coordinator?.updateQueue({
				sessionId: snapshot.sessionId,
				generation: snapshot.generation,
			}, released);
		}
		this.bindQueue();
		this.#options.publishDirect("session.changed", {
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
		});
		this.#options.publish("status.changed", this.#options.status());
		if (snapshot.pendingApproval) {
			this.#options.publish(
				"approval.request",
				approvalRequestPayload(snapshot.pendingApproval, snapshot.generation),
			);
		}
		if (snapshot.pendingClarification) {
			this.#options.publish(
				"clarify.request",
				clarificationRequestPayload(snapshot.pendingClarification, snapshot.generation),
			);
		}
	}

	async #transitionPayload(snapshot: SessionSnapshot): Promise<JsonObject> {
		const [authProviders, authStatus] = await Promise.all([
			this.#options.authProviders(),
			this.#options.credentialReadiness(),
		]);
		return {
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
			...(authProviders.length > 0 ? { auth_providers: authProviders } : {}),
			...(authStatus ? { auth_status: credentialReadinessPayload(authStatus) } : {}),
			read_only: snapshot.readOnly,
			lines: [],
			background_shells: this.#options.activeShellPayloads(),
		};
	}

	#requiredCoordinator(message: string): SessionCoordinator<NodeGatewayRuntime> {
		const coordinator = this.#options.coordinator;
		if (!coordinator) throw new GatewayFailure("method_not_found", message);
		return coordinator;
	}
}

function sessionQueryFromParams(params: JsonObject): SessionQuery {
	const workspaceRoot = optionalBoundedIdentity(params.workspace_root, "workspace_root");
	const search = optionalBoundedIdentity(params.search, "search");
	const model = optionalBoundedIdentity(params.model, "model");
	const collaborationMode = collaborationModeParameter(params.collaboration_mode);
	const permission = params.permission_profile === undefined
		? undefined
		: permissionProfile(params.permission_profile);
	const lifecycleStatus = optionalSessionLifecycleStatus(params.status);
	const limit = params.limit === undefined ? 50 : integerValue(params.limit);
	if (limit === undefined || limit < 1 || limit > 200) {
		throw new GatewayFailure("invalid_params", "session list limit must be between 1 and 200.");
	}
	return Object.freeze({
		...(workspaceRoot ? { workspaceRoot } : {}),
		...(search ? { search } : {}),
		...(model ? { model } : {}),
		...(collaborationMode ? { collaborationMode } : {}),
		...(permission ? { permissionProfile: permission } : {}),
		...(lifecycleStatus ? { lifecycleStatus } : {}),
		includeArchived: params.include_archived === true,
		includeDeleted: params.include_deleted === true,
		limit,
	});
}

function sessionSummaryPayload(summary: SessionSummary, activeSessionId?: string): JsonObject {
	return {
		version: summary.version,
		id: summary.id,
		...(summary.title ? { title: summary.title } : {}),
		workspace: summary.cwd,
		workspace_root: summary.cwd,
		cwd: summary.cwd,
		created: summary.createdAt,
		created_at: summary.createdAt,
		updated: summary.updatedAt,
		updated_at: summary.updatedAt,
		last_active: summary.lastActiveAt,
		modified: summary.lastActiveAt,
		model: summary.model,
		provider: summary.provider,
		reasoning_effort: summary.reasoningEffort,
		collaboration_mode: summary.collaborationMode,
		permission_profile: summary.permissionProfile,
		status: summary.lifecycleStatus,
		storage_status: summary.storageStatus,
		lock_state: summary.leaseState,
		pending_state: summary.pendingState,
		message_count: summary.messageCount,
		summary_count: summary.summaryCount,
		metadata_revision: summary.metadataRevision,
		...(summary.parentId ? { parent_session_id: summary.parentId } : {}),
		...(summary.forkPoint === undefined ? {} : { fork_point: summary.forkPoint }),
		...(summary.preferenceIssue ? { preference_issue: summary.preferenceIssue } : {}),
		...(summary.metadataIssue ? { metadata_issue: summary.metadataIssue } : {}),
		...(activeSessionId ? { current: summary.id === activeSessionId } : {}),
	};
}

function resumeRepairPreviewPayload(preview: ResumeRepairPreview): JsonObject {
	return {
		version: preview.version,
		session: sessionSummaryPayload(preview.session),
		ready: preview.ready,
		requires_confirmation: preview.requiresConfirmation,
		issues: preview.issues.map((item) => ({
			code: item.code,
			blocking: item.blocking,
			message: item.message,
			...(item.action ? { action: item.action } : {}),
		})),
		actions: [...preview.actions],
	};
}

function resumePreviewAfterConfirmedAction(
	preview: ResumeRepairPreview,
	action: ResumeRepairAction,
): ResumeRepairPreview {
	if (action !== "takeover_stale_owner") return preview;
	const issues = preview.issues.filter((item) => item.code !== "stale_owner");
	return Object.freeze({
		...preview,
		ready: !issues.some((item) => item.blocking),
		requiresConfirmation: issues.some((item) => item.blocking && item.action !== undefined),
		issues: Object.freeze(issues),
		actions: Object.freeze(preview.actions.filter((item) => item !== action)),
	});
}

function optionalSessionLifecycleStatus(value: unknown): SessionQuery["lifecycleStatus"] {
	if (value === undefined || value === null || value === "") return undefined;
	if (value === "active" || value === "archived" || value === "deleted"
		|| value === "waiting_approval" || value === "waiting_clarification"
		|| value === "interrupted") return value;
	throw new GatewayFailure("invalid_params", "session status is invalid.");
}

function isResumeRepairAction(value: string): value is ResumeRepairAction {
	return value === "takeover_stale_owner"
		|| value === "unarchive"
		|| value === "fork_with_current_settings";
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function collaborationModeParameter(value: unknown): "default" | "plan" | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (value === "default" || value === "plan") return value;
	throw new GatewayFailure("invalid_params", "collaboration_mode is invalid.");
}

function permissionProfile(value: unknown): PermissionProfile {
	if (value === "read-only" || value === "workspace" || value === "full-access") return value;
	throw new GatewayFailure("invalid_params", "permission_profile is invalid.");
}
