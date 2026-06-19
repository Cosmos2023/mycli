import type {
	MycliShellAuthProvider,
	MycliShellBash,
	MycliShellMessage,
	MycliShellModel,
	MycliShellPendingApproval,
	MycliShellResource,
	MycliShellPlanStep,
	MycliShellSession,
	MycliShellSessionTree,
	MycliShellSessionTreeNode,
	MycliShellState,
	MycliShellSubagent,
	MycliShellTranscriptBlock,
	MycliShellTool,
	MycliShellToolStatus,
	MycliShellVisualSettings,
} from "../model.ts";

export type RuntimeTranscriptItem = {
	id: string;
	type: string;
	text: string;
	folded?: boolean;
	metadata?: Record<string, unknown>;
};

export type RuntimeShellState = {
	sessionId: string | null;
	sessionTitle: string | null;
	workspace: string;
	model: string;
	collaborationMode: "default" | "plan";
	provider: string;
	trust: { state?: string; workspace?: string };
	trustGateDismissed: boolean;
	status: Record<string, unknown>;
	transcript: RuntimeTranscriptItem[];
	turnRunning: boolean;
	activeAssistantItemId: string | null;
	queuedInputs: string[];
	queuedSteeringInputs: string[];
	queuedFollowUpInputs: string[];
	liveStatus: { state: string; text: string; kind?: string; message?: string } | null;
	liveReasoning: { text: string; kind: string } | null;
	viewMode: "default" | "verbose" | "focus";
	statusbarMode: "off" | "compact" | "full";
	settings: MycliShellVisualSettings;
	pendingApproval: Record<string, unknown> | null;
	pendingClarification: Record<string, unknown> | null;
	activePlan: MycliShellPlanStep[];
	authProviders: MycliShellAuthProvider[];
	resources: MycliShellResource[];
};

export function initialRuntimeState(): RuntimeShellState {
	return {
		sessionId: null,
		sessionTitle: null,
		workspace: process.cwd(),
		model: "",
		collaborationMode: "default",
		provider: "",
		trust: { state: "unknown", workspace: process.cwd() },
		trustGateDismissed: false,
		status: {},
		transcript: [],
		turnRunning: false,
		activeAssistantItemId: null,
		queuedInputs: [],
		queuedSteeringInputs: [],
		queuedFollowUpInputs: [],
		liveStatus: null,
		liveReasoning: null,
		viewMode: "default",
		statusbarMode: "full",
		settings: defaultVisualSettings(),
		pendingApproval: null,
		pendingClarification: null,
		activePlan: [],
		authProviders: [],
		resources: [],
	};
}

export function projectRuntimeState(state: RuntimeShellState, sessions: MycliShellSession[] = []): MycliShellState {
	const messages: MycliShellMessage[] = [];
	const tools: MycliShellTool[] = [];
	const bash: MycliShellBash[] = [];
	const transcript: MycliShellTranscriptBlock[] = [];

	for (const item of state.transcript) {
		if (isInternalTaskNotification(item.text)) {
			continue;
		}
		if (item.type === "user") {
			const message: MycliShellMessage = { id: item.id, role: "user", text: item.text };
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "assistant_stream" || item.type === "assistant_final") {
			const thinking = reasoningForAssistant(item, state);
			const message: MycliShellMessage = {
				id: item.id,
				role: "assistant",
				text: item.text,
				...(thinking ? { thinking, thinkingHidden: true } : {}),
			};
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "warning") {
			const message: MycliShellMessage = { id: item.id, role: "warning", text: item.text };
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "error") {
			const message: MycliShellMessage = { id: item.id, role: "error", text: item.text };
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "system_notice" || item.type === "command_output" || item.type === "clarification" || item.type === "approval") {
			const message: MycliShellMessage = { id: item.id, role: "system", text: item.text };
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "proposed_plan") {
			transcript.push({
				id: item.id,
				kind: "plan",
				plan: {
					id: item.id,
					text: item.text,
					status: planStatus(item.metadata),
				},
			});
		} else if (item.type === "tool_summary" || item.type === "tool_detail") {
			const tool = toolFromTranscriptItem(item, state.workspace, state.viewMode, state.settings.toolDetailsDefault);
			if (isShellTool(tool.name)) {
				const bashItem: MycliShellBash = {
					id: tool.id,
					command: tool.args || tool.outputPreview || tool.name,
					status: tool.status,
					outputPreview: tool.outputPreview,
					hiddenLineCount: tool.hiddenLineCount,
					expanded: tool.expanded,
				};
				bash.push(bashItem);
				transcript.push({ id: item.id, kind: "bash", bash: bashItem });
			} else {
				tools.push(tool);
				transcript.push({ id: item.id, kind: "tool", tool });
			}
		} else if (item.type === "subagent") {
			const subagent = subagentFromTranscriptItem(item);
			if (subagent) {
				transcript.push({ id: item.id, kind: "subagent", subagent });
			}
		}
	}

	return {
		title: "mycli",
		messages,
		tools,
		bash,
		transcript,
		activePlan: state.activePlan.length > 0 ? state.activePlan : undefined,
		footer: {
			cwd: state.workspace || process.cwd(),
			sessionName: state.sessionTitle ?? state.sessionId ?? undefined,
			provider: state.provider || undefined,
			model: state.model || undefined,
			reasoningLevel: reasoningLevelFromStatus(state.status),
			...usageFooterData(state.status),
			queueCount: queuedInputCount(state),
			steeringQueueCount: state.queuedSteeringInputs.length,
			followUpQueueCount: state.queuedFollowUpInputs.length,
			trust: state.trust.state ?? "unknown",
			collaborationMode: state.collaborationMode,
			liveState: footerLiveState(state),
			autoCompact: true,
		},
		pendingNotice: pendingNotice(state),
		pendingApproval: pendingApprovalFromRecord(state.pendingApproval),
		models: modelListFromStatus(state.status, state.provider, state.model),
		authProviders: state.authProviders,
		currentModel: currentModel(state.provider, state.model, reasoningLevelFromStatus(state.status)),
		settings: {
			...state.settings,
			viewMode: state.viewMode,
			statusbarMode: state.statusbarMode,
		},
		sessions,
		resources: state.resources,
	};
}

export function runtimeStateWithSettings(state: RuntimeShellState, settings: MycliShellVisualSettings): RuntimeShellState {
	const nextSettings = normalizeVisualSettings(settings, state.settings);
	return {
		...state,
		settings: nextSettings,
		viewMode: nextSettings.viewMode ?? state.viewMode,
		statusbarMode: nextSettings.statusbarMode ?? state.statusbarMode,
	};
}

export function settingsFromResult(payload: Record<string, unknown>): MycliShellVisualSettings {
	const settings = recordValue(payload.settings);
	return normalizeVisualSettings(Object.keys(settings).length > 0 ? settings : payload);
}

export function resourcesFromResult(payload: Record<string, unknown>): MycliShellResource[] {
	const resources = Array.isArray(payload.resources) ? payload.resources : [];
	return resources.map(resourceFromUnknown).filter((resource): resource is MycliShellResource => resource !== null);
}

function footerLiveState(state: RuntimeShellState): string {
	if (state.turnRunning) {
		return state.liveStatus?.text ?? "Running";
	}
	if (state.pendingApproval) {
		return "Waiting approval";
	}
	if (state.pendingClarification) {
		return "Waiting clarification";
	}
	const liveStatusKind = state.liveStatus?.kind ?? state.liveStatus?.state;
	if (liveStatusKind === "failed") {
		return state.liveStatus?.text ?? liveStatusKind;
	}
	if (state.collaborationMode === "plan") {
		return "Plan";
	}
	return "Idle";
}

export function runtimeStateFromBootstrap(state: RuntimeShellState, payload: Record<string, unknown>): RuntimeShellState {
	const status = recordValue(payload.status);
	const trust = trustFromPayload(payload.trust ?? status.trust, String(payload.workspace ?? state.workspace));
	const welcome = recordValue(payload.welcome);
	const startupMark = recordValue(welcome.startup_mark);
	const welcomeText = welcome
		? `${String(startupMark.text ?? "mycli")}\n${String(welcome.workspace ?? payload.workspace ?? "")}`.trim()
		: "mycli";
	return {
		...state,
		sessionId: stringValue(payload.session_id) ?? state.sessionId,
		sessionTitle: stringValue(payload.session_title) ?? state.sessionTitle,
		workspace: stringValue(payload.workspace) ?? state.workspace,
		model: stringValue(payload.model) ?? state.model,
		collaborationMode: collaborationModeValue(payload.collaboration_mode) ?? collaborationModeValue(status.collaboration_mode) ?? state.collaborationMode,
		provider: stringValue(payload.provider) ?? state.provider,
		authProviders: authProvidersFromUnknown(payload.auth_providers),
		status,
		trust,
		trustGateDismissed: state.trustGateDismissed || trust.state !== "unknown",
		transcript: [
			...state.transcript,
			{ id: "welcome", type: "system_notice", text: welcomeText, folded: false, metadata: welcome },
		],
	};
}

export function runtimeStateFromTranscript(state: RuntimeShellState, payload: Record<string, unknown>): RuntimeShellState {
	const items = Array.isArray(payload.items)
		? payload.items.filter(isTranscriptItem).map((item) => ({ ...item, metadata: recordValue(item.metadata) }))
		: [];
	return { ...state, transcript: [...state.transcript, ...items] };
}

export function reduceRuntimeEvent(state: RuntimeShellState, method: string, params: Record<string, unknown>): RuntimeShellState {
	if (method === "runtime.event") {
		const type = stringValue(params.type);
		const payload = recordValue(params.payload);
		return type ? reduceRuntimeEvent(state, type, payload) : state;
	}
	if (method === "turn.started") {
		return {
			...state,
			turnRunning: true,
			activeAssistantItemId: nextId("assistant"),
			liveStatus: { state: "running", kind: "running", text: "Running" },
			pendingApproval: null,
			pendingClarification: null,
		};
	}
	if (method === "message.delta") {
		const assistantId = state.activeAssistantItemId ?? nextId("assistant");
		return {
			...state,
			activeAssistantItemId: assistantId,
			transcript: applyAssistantDelta(state.transcript, assistantId, String(params.text ?? "")),
		};
	}
	if (method === "message.complete") {
		const text = String(params.text ?? "");
		const assistantId = state.activeAssistantItemId;
		return {
			...state,
			turnRunning: params.final === true ? false : state.turnRunning,
			activeAssistantItemId: params.final === true ? null : state.activeAssistantItemId,
			liveReasoning: null,
			transcript: params.final === true ? reconcileFinalAnswer(state.transcript, assistantId, text) : state.transcript,
		};
	}
	if (method === "plan.proposed") {
		const assistantId = state.activeAssistantItemId;
		return {
			...state,
			activeAssistantItemId: null,
			transcript: applyProposedPlan(sealActiveAssistantStream(state.transcript, assistantId), params),
		};
	}
	if (method === "plan.updated") {
		const planSteps = planStepsFromEvent(params);
		return planSteps.length > 0 ? { ...state, activePlan: planSteps } : state;
	}
	if (method === "subagent.updated") {
		const subagent = recordValue(params.subagent);
		const item = transcriptItemFromSubagent(subagent);
		if (!item) {
			return state;
		}
		return {
			...state,
			transcript: upsertSubagentTranscriptItem(state.transcript, item),
		};
	}
	if (method === "reasoning.delta" || method === "thinking.delta") {
		const text = reasoningText(params);
		const transcript =
			method === "thinking.delta" && state.liveReasoning?.text === text
				? state.transcript
				: applyReasoning(state.transcript, text, params);
		return {
			...state,
			turnRunning: true,
			liveReasoning: { kind: method === "thinking.delta" ? "thinking" : "reasoning", text },
			transcript,
		};
	}
	if (method === "tool.start" || method === "tool.progress" || method === "tool.complete" || method === "tool.failed") {
		const transcript =
			method === "tool.start" && state.activeAssistantItemId
				? sealAssistantStream(state.transcript, state.activeAssistantItemId)
				: state.transcript;
		return {
			...state,
			activeAssistantItemId: method === "tool.start" ? null : state.activeAssistantItemId,
			transcript: applyToolLifecycle(transcript, method, params),
		};
	}
	if (method === "compaction.started" || method === "compaction.completed") {
		return {
			...state,
			turnRunning: true,
			liveStatus:
				method === "compaction.started"
					? { state: "running", kind: "compaction", text: "Compressing context" }
					: state.liveStatus,
			transcript: applyCompactionLifecycle(state.transcript, method, params),
		};
	}
	if (method === "turn.completed") {
		const planSteps = planStepsFromEvent(params);
		const turnState = stringValue(params.turn_state);
		const assistantMessage = stringValue(params.assistant_message);
		const nextActivePlan = planSteps.length > 0 ? planSteps : state.activePlan;
		const failedTranscript =
			turnState === "failed" && assistantMessage
				? [...state.transcript, { id: nextId("error"), type: "error", text: assistantMessage, folded: false, metadata: params }]
				: state.transcript;
		return {
			...state,
			turnRunning: false,
			activeAssistantItemId: null,
			liveReasoning: null,
			liveStatus:
				turnState === "failed" && assistantMessage
					? { state: "failed", kind: "failed", text: assistantMessage, message: assistantMessage }
					: { state: "completed", kind: "completed", text: "Completed" },
			activePlan: shouldClearCompletedPlan(turnState, nextActivePlan) ? [] : nextActivePlan,
			pendingApproval: params.pending_decision === true || params.turn_state === "waiting_approval" ? state.pendingApproval : null,
			pendingClarification: params.turn_state === "waiting_clarification" ? state.pendingClarification : null,
			transcript: failedTranscript,
		};
	}
	if (method === "turn.status" || method === "status.update") {
		return {
			...state,
			turnRunning: params.state === "running" || params.state === "waiting_approval" || params.state === "waiting_clarification",
			liveStatus: {
				state: stringValue(params.state) ?? "running",
				kind: stringValue(params.kind) ?? "status",
				text: stringValue(params.text) ?? stringValue(params.message) ?? "Running",
				...(stringValue(params.message) ? { message: stringValue(params.message)! } : {}),
			},
		};
	}
	if (method === "turn.failed" || method === "gateway.error") {
		const message = String(params.message ?? "Request failed");
		const previousWaitingStatus =
			method === "gateway.error" &&
			(state.liveStatus?.state === "waiting_approval" || state.liveStatus?.state === "waiting_clarification")
				? state.liveStatus
				: null;
		return {
			...state,
			turnRunning: previousWaitingStatus ? state.turnRunning : false,
			activeAssistantItemId: null,
			liveReasoning: null,
			liveStatus: previousWaitingStatus ?? { state: "failed", kind: "failed", text: message, message },
			transcript: [...state.transcript, { id: nextId("error"), type: "error", text: message, folded: false, metadata: params }],
		};
	}
	if (method === "approval.request" || method === "approval.pending") {
		return {
			...state,
			pendingApproval: params,
			turnRunning: false,
			activeAssistantItemId: null,
			liveStatus: { state: "waiting_approval", kind: "approval", text: "Waiting approval" },
			transcript: [
				...state.transcript,
				{ id: nextId("approval"), type: "approval", text: String(params.preview ?? "Approval required"), folded: false, metadata: params },
			],
		};
	}
	if (method === "approval.respond") {
		return { ...state, pendingApproval: null };
	}
	if (method === "clarify.request") {
		return {
			...state,
			pendingClarification: params,
			turnRunning: false,
			activeAssistantItemId: null,
			liveStatus: { state: "waiting_clarification", kind: "clarification", text: "Waiting clarification" },
			transcript: [
				...state.transcript,
				{ id: nextId("clarification"), type: "clarification", text: String(params.question ?? "Clarification required"), folded: false, metadata: params },
			],
		};
	}
	if (method === "clarify.respond") {
		return { ...state, pendingClarification: null };
	}
	if (method === "status.changed") {
		const trust = trustFromPayload(params.trust, state.workspace);
		const turnRunning = booleanValue(params.turn_running);
		const queuedSteering = stringArrayValue(params.queued_steering);
		const queuedFollowUp = stringArrayValue(params.queued_follow_up);
		const visibleSteering = visibleQueuedMessages(queuedSteering);
		const visibleFollowUp = visibleQueuedMessages(queuedFollowUp);
		return {
			...state,
			status: params,
			turnRunning: turnRunning ?? state.turnRunning,
			activeAssistantItemId: turnRunning === false ? null : state.activeAssistantItemId,
			liveReasoning: turnRunning === false ? null : state.liveReasoning,
			queuedSteeringInputs: visibleSteering,
			queuedFollowUpInputs: visibleFollowUp,
			queuedInputs: [...visibleSteering, ...visibleFollowUp],
			sessionTitle: stringValue(params.session_title) ?? state.sessionTitle,
			model: stringValue(params.model) ?? state.model,
			collaborationMode: collaborationModeValue(params.collaboration_mode) ?? state.collaborationMode,
			provider: stringValue(params.provider) ?? state.provider,
			trust,
			trustGateDismissed: state.trustGateDismissed || trust.state !== "unknown",
		};
	}
	if (method === "workspace.trust.changed") {
		const trust = trustFromPayload(params, state.workspace);
		return { ...state, trust, trustGateDismissed: state.trustGateDismissed || trust.state !== "unknown" };
	}
	if (method === "turn.queue.updated") {
		const steering = stringArrayValue(params.steering) ?? [];
		const followUp = stringArrayValue(params.follow_up) ?? [];
		return runtimeStateWithMessageQueues(state, { steering, followUp });
	}
	if (method === "session.changed") {
		return {
			...state,
			sessionId: stringValue(params.session_id) ?? state.sessionId,
			sessionTitle: stringValue(params.session_title) ?? state.sessionTitle,
		};
	}
	return state;
}

export function runtimeStateWithUserMessage(state: RuntimeShellState, message: string): RuntimeShellState {
	return {
		...state,
		transcript: [...state.transcript, { id: nextId("user"), type: "user", text: message, folded: false, metadata: {} }],
	};
}

export function runtimeStateWithQueuedInputs(state: RuntimeShellState, queuedInputs: string[]): RuntimeShellState {
	const visibleQueuedInputs = visibleQueuedMessages(queuedInputs);
	return {
		...state,
		queuedInputs: visibleQueuedInputs,
	};
}

export function runtimeStateWithMessageQueues(
	state: RuntimeShellState,
	queues: { steering: string[]; followUp: string[] },
): RuntimeShellState {
	const steering = visibleQueuedMessages(queues.steering);
	const followUp = visibleQueuedMessages(queues.followUp);
	return {
		...state,
		queuedSteeringInputs: steering,
		queuedFollowUpInputs: followUp,
		queuedInputs: [...steering, ...followUp],
	};
}

function queuedInputCount(state: RuntimeShellState): number {
	const splitQueueCount = state.queuedSteeringInputs.length + state.queuedFollowUpInputs.length;
	return splitQueueCount > 0 ? splitQueueCount : state.queuedInputs.length;
}

function visibleQueuedMessages(messages: string[]): string[] {
	return messages.filter((message) => !isInternalTaskNotification(message));
}

function isInternalTaskNotification(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("<task-notification>") || trimmed.startsWith("<task-notification ");
}

function shouldClearCompletedPlan(turnState: string | null, planSteps: MycliShellPlanStep[] | undefined): boolean {
	if (turnState !== "completed" || !planSteps?.length) {
		return false;
	}
	return planSteps.every((step) => step.status === "completed");
}

export function runtimeStateWithCommandResult(state: RuntimeShellState, command: string, result: Record<string, unknown>): RuntimeShellState {
	const lines = Array.isArray(result.lines) ? result.lines.map((line) => String(line)) : [String(result.message ?? "Done")];
	const collaborationMode = collaborationModeValue(result.collaboration_mode);
	return {
		...state,
		collaborationMode: collaborationMode ?? state.collaborationMode,
		transcript: [...state.transcript, { id: nextId("command"), type: "command_output", text: lines.join("\n"), folded: false, metadata: { command } }],
	};
}

export function sessionsFromResult(result: Record<string, unknown>): MycliShellSession[] {
	const raw = Array.isArray(result.sessions) ? result.sessions : Array.isArray(result.items) ? result.items : [];
	return raw.map(sessionFromUnknown).filter((session): session is MycliShellSession => session !== null);
}

export function sessionTreeFromResult(result: Record<string, unknown>): MycliShellSessionTree {
	const rawNodes = Array.isArray(result.nodes) ? result.nodes : [];
	return {
		sessionId: stringValue(result.session_id) ?? stringValue(result.sessionId) ?? "",
		activePath: stringArrayValue(result.active_path ?? result.activePath),
		nodes: rawNodes.map(sessionTreeNodeFromUnknown).filter((node): node is MycliShellSessionTreeNode => node !== null),
	};
}

function sessionFromUnknown(value: unknown): MycliShellSession | null {
	const record = recordValue(value);
	const id = stringValue(record.id) ?? stringValue(record.session_id) ?? stringValue(record.path);
	if (!id) return null;
	return {
		id,
		title: stringValue(record.title) ?? stringValue(record.name) ?? undefined,
		cwd: stringValue(record.cwd) ?? stringValue(record.workspace) ?? undefined,
		workspace: stringValue(record.workspace) ?? stringValue(record.workspace_root) ?? undefined,
		modified: stringValue(record.modified) ?? stringValue(record.last_active) ?? stringValue(record.updated_at) ?? undefined,
		created: stringValue(record.created) ?? stringValue(record.created_at) ?? undefined,
		updated: stringValue(record.updated) ?? stringValue(record.updated_at) ?? undefined,
		lastActive: stringValue(record.last_active) ?? stringValue(record.lastActive) ?? undefined,
		messageCount: numberValue(record.message_count) ?? numberValue(record.messageCount) ?? undefined,
		firstMessage: stringValue(record.first_message) ?? stringValue(record.firstMessage) ?? undefined,
		allMessagesText: stringValue(record.all_messages_text) ?? stringValue(record.allMessagesText) ?? undefined,
		parentSessionId: stringValue(record.parent_session_id) ?? stringValue(record.parentSessionId) ?? undefined,
		parentSessionPath: stringValue(record.parent_session_path) ?? stringValue(record.parentSessionPath) ?? undefined,
		named: booleanValue(record.named) ?? undefined,
		current: booleanValue(record.current) ?? undefined,
	};
}

function sessionTreeNodeFromUnknown(value: unknown): MycliShellSessionTreeNode | null {
	const record = recordValue(value);
	const id = stringValue(record.id);
	const kind = stringValue(record.kind);
	const sessionId = stringValue(record.session_id) ?? stringValue(record.sessionId);
	if (!id || !sessionId || (kind !== "session" && kind !== "message")) return null;
	return {
		id,
		kind,
		sessionId,
		parentId: stringValue(record.parent_id) ?? stringValue(record.parentId) ?? undefined,
		depth: numberValue(record.depth) ?? 0,
		role: stringValue(record.role) ?? kind,
		summary: stringValue(record.summary) ?? "",
		timestamp: stringValue(record.timestamp) ?? undefined,
		label: stringValue(record.label) ?? undefined,
		messageIndex: numberValue(record.message_index) ?? numberValue(record.messageIndex) ?? undefined,
		anchorId: stringValue(record.anchor_id) ?? stringValue(record.anchorId) ?? undefined,
		toolName: stringValue(record.tool_name) ?? stringValue(record.toolName) ?? undefined,
		active: booleanValue(record.active) ?? undefined,
		onActivePath: booleanValue(record.on_active_path) ?? booleanValue(record.onActivePath) ?? undefined,
		messageCount: numberValue(record.message_count) ?? numberValue(record.messageCount) ?? undefined,
		preview: stringValue(record.preview) ?? undefined,
	};
}

function pendingNotice(state: RuntimeShellState): string | undefined {
	if (state.pendingApproval) {
		return `Approval required: ${String(state.pendingApproval.preview ?? state.pendingApproval.tool_name ?? "")}`.trim();
	}
	if (state.pendingClarification) {
		return `Clarification required: ${String(state.pendingClarification.question ?? "")}`.trim();
	}
	return undefined;
}

function pendingApprovalFromRecord(value: Record<string, unknown> | null): MycliShellPendingApproval | undefined {
	if (!value) {
		return undefined;
	}
	const decisionId = stringValue(value.decision_id) ?? stringValue(value.decisionId);
	if (!decisionId) {
		return undefined;
	}
	const options = approvalOptionsFromPayload(value.options);
	return {
		decisionId,
		preview: stringValue(value.preview) ?? stringValue(value.action) ?? stringValue(value.tool_name) ?? "Approval required",
		reason: stringValue(value.reason) ?? undefined,
		toolName: stringValue(value.tool_name) ?? stringValue(value.toolName) ?? undefined,
		workerName:
			stringValue(value.worker_name) ??
			stringValue(value.workerName) ??
			stringValue(value.agent_name) ??
			stringValue(value.agentName) ??
			stringValue(value.role) ??
			undefined,
		workerColor: stringValue(value.worker_color) ?? stringValue(value.workerColor) ?? undefined,
		childSessionId: stringValue(value.child_session_id) ?? stringValue(value.childSessionId) ?? undefined,
		options: options.length > 0 ? options : defaultApprovalOptions(),
		risk: stringValue(value.risk) ?? undefined,
		riskReason: stringValue(value.risk_reason) ?? stringValue(value.riskReason) ?? undefined,
	};
}

function approvalOptionsFromPayload(value: unknown): MycliShellPendingApproval["options"] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => {
			const record = recordValue(item);
			const choice = stringValue(record.choice) ?? stringValue(record.value);
			if (!choice) {
				return null;
			}
			return {
				choice,
				label: stringValue(record.label) ?? choice,
			};
		})
		.filter((item): item is MycliShellPendingApproval["options"][number] => item !== null);
}

function defaultApprovalOptions(): MycliShellPendingApproval["options"] {
	return [
		{ choice: "approve_once", label: "Allow once" },
		{ choice: "reject", label: "Reject" },
	];
}

function toolFromTranscriptItem(
	item: RuntimeTranscriptItem,
	workspace: string,
	viewMode: RuntimeShellState["viewMode"],
	toolDetailsDefault: MycliShellVisualSettings["toolDetailsDefault"] = "collapsed",
): MycliShellTool {
	const metadata = recordValue(item.metadata);
	const status = toolStatus(metadata);
	const name = stringValue(metadata.tool_name) ?? stringValue(metadata.name) ?? item.text.split(/\s+/, 1)[0] ?? "Tool";
	const rawPayload = recordValue(metadata.raw_payload);
	const argumentsPayload = recordValue(metadata.arguments);
	const target =
		stringValue(metadata.path) ??
		stringValue(rawPayload.path) ??
		stringValue(argumentsPayload.file_path) ??
		stringValue(argumentsPayload.path) ??
		stringValue(metadata.command) ??
		stringValue(rawPayload.command) ??
		stringValue(metadata.query) ??
		stringValue(rawPayload.query) ??
		stringValue(metadata.context) ??
		stringValue(metadata.args_preview) ??
		item.text.replace(new RegExp(`^${escapeRegExp(name)}\\s*`), "");
	const contentPreview = contentPreviewForTool(name, metadata);
	const diffPreview = diffPreviewForTool(metadata);
	const outputPreview = outputPreviewForTool(name, status, metadata, item.text, contentPreview, diffPreview);
	const errorPreview = stringValue(metadata.error) ?? (status === "error" ? item.text : undefined);
	return {
		id: item.id,
		name,
		args: compactTarget(commandTargetPreview(name, target), workspace) ?? undefined,
		status,
		durationMs: durationMs(metadata),
		mutating: mutatingTool(name, metadata),
		contentPreview,
		contentLineCount: numberValue(metadata.content_line_count) ?? (contentPreview ? lineCount(contentPreview) : undefined),
		diffPreview,
		hidden: shouldHideTool(name, status, mutatingTool(name, metadata), viewMode),
		outputPreview,
		errorPreview,
		hiddenLineCount: hiddenLineCountForTool(metadata, contentPreview),
		expanded: item.folded === false || (item.folded === undefined && toolDetailsDefault === "expanded"),
	};
}

function transcriptItemFromSubagent(subagent: Record<string, unknown>): RuntimeTranscriptItem | null {
	const childSessionId = stringValue(subagent.child_session_id) ?? stringValue(subagent.childSessionId);
	const role = stringValue(subagent.role) ?? stringValue(subagent.agent_type) ?? stringValue(subagent.name);
	if (!childSessionId || !role) {
		return null;
	}
	const id = stringValue(subagent.run_id) ?? `subagent:${childSessionId}`;
	return {
		id,
		type: "subagent",
		text: stringValue(subagent.summary) ?? stringValue(subagent.report) ?? "",
		folded: true,
		metadata: subagent,
	};
}

function subagentFromTranscriptItem(item: RuntimeTranscriptItem): MycliShellSubagent | null {
	const metadata = recordValue(item.metadata);
	const childSessionId = stringValue(metadata.child_session_id) ?? stringValue(metadata.childSessionId);
	const role = stringValue(metadata.role) ?? stringValue(metadata.agent_type) ?? stringValue(metadata.name);
	if (!childSessionId || !role) {
		return null;
	}
	const status = stringValue(metadata.status) ?? "completed";
	return {
		id: stringValue(metadata.run_id) ?? item.id,
		role,
		description: stringValue(metadata.description) ?? undefined,
		status,
		mode: stringValue(metadata.mode) ?? undefined,
		childSessionId,
		parentTurnId: stringValue(metadata.parent_turn_id) ?? stringValue(metadata.parentTurnId) ?? undefined,
		summary: (stringValue(metadata.summary) ?? stringValue(metadata.report) ?? item.text) || undefined,
		toolCalls: numberValue(metadata.tool_calls) ?? numberValue(metadata.toolCalls) ?? undefined,
		tokens: numberValue(metadata.total_tokens) ?? numberValue(metadata.tokens) ?? undefined,
		durationMs: numberValue(metadata.duration_ms) ?? durationSecondsToMs(metadata.duration_s),
		error: stringValue(metadata.error) ?? undefined,
		path: stringValue(metadata.path) ?? undefined,
		startedAt: stringValue(metadata.started_at) ?? stringValue(metadata.startedAt) ?? undefined,
		completedAt: stringValue(metadata.completed_at) ?? stringValue(metadata.completedAt) ?? undefined,
		progress: subagentProgressFromMetadata(metadata),
	};
}

function subagentProgressFromMetadata(metadata: Record<string, unknown>): MycliShellSubagent["progress"] {
	const raw = Array.isArray(metadata.progress) ? metadata.progress : [];
	return raw
		.map((item): NonNullable<MycliShellSubagent["progress"]>[number] | null => {
			const record = recordValue(item);
			const kind = stringValue(record.kind);
			if (!kind) {
				return null;
			}
			return {
				kind,
				toolName: stringValue(record.tool_name) ?? stringValue(record.toolName) ?? undefined,
				callId: stringValue(record.call_id) ?? stringValue(record.callId) ?? undefined,
				summary: stringValue(record.summary) ?? undefined,
				status: stringValue(record.status) ?? undefined,
			};
		})
		.filter((item): item is NonNullable<MycliShellSubagent["progress"]>[number] => item !== null);
}

function durationSecondsToMs(value: unknown): number | undefined {
	const seconds = numberValue(value);
	return seconds === null ? undefined : Math.round(seconds * 1000);
}

function contentPreviewForTool(name: string, metadata: Record<string, unknown>): string | undefined {
	if (!isWriteTool(name)) {
		return undefined;
	}
	return (
		stringValue(metadata.content_preview) ??
		stringValue(recordValue(metadata.arguments).content) ??
		stringValue(metadata.content) ??
		stringValue(recordValue(metadata.raw_payload).content) ??
		stringValue(recordValue(recordValue(metadata.raw_payload).arguments).content) ??
		undefined
	);
}

function diffPreviewForTool(metadata: Record<string, unknown>): string | undefined {
	return (
		stringValue(metadata.diff) ??
		stringValue(recordValue(metadata.raw_payload).diff) ??
		stringValue(recordValue(metadata.details).diff) ??
		stringValue(recordValue(recordValue(metadata.raw_payload).details).diff) ??
		undefined
	);
}

function outputPreviewForTool(
	name: string,
	status: MycliShellToolStatus,
	metadata: Record<string, unknown>,
	itemText: string,
	contentPreview: string | undefined,
	diffPreview: string | undefined,
): string | undefined {
	if (status === "success" && (contentPreview || diffPreview) && mutatingTool(name, metadata)) {
		return undefined;
	}
	if (isShellTool(name)) {
		return stringValue(metadata.summary) ?? stringValue(metadata.output_preview) ?? stringValue(metadata.stdout) ?? stringValue(metadata.stderr) ?? undefined;
	}
	return stringValue(metadata.summary) ?? (status === "success" ? itemText : undefined);
}

function hiddenLineCountForTool(metadata: Record<string, unknown>, contentPreview: string | undefined): number | undefined {
	if (metadata.summary_truncated === true || metadata.error_truncated === true) {
		return 1;
	}
	if (!contentPreview) {
		return undefined;
	}
	const hidden = lineCount(contentPreview) - 10;
	return hidden > 0 ? hidden : undefined;
}

function isWriteTool(name: string): boolean {
	return name.toLowerCase() === "write";
}

function lineCount(text: string): number {
	const trimmed = text.replace(/\n+$/g, "");
	return trimmed ? trimmed.split("\n").length : 0;
}

function shouldHideTool(
	name: string,
	status: MycliShellToolStatus,
	mutating: boolean,
	viewMode: RuntimeShellState["viewMode"],
): boolean {
	if (viewMode === "verbose") return false;
	if (status === "running" || status === "error" || mutating) return false;
	const lower = name.toLowerCase();
	if (lower === "bash" || lower === "shell") return false;
	if (viewMode === "focus") return true;
	return ["read", "grep", "glob", "ls", "gitstatus", "gitlog", "gitshow", "gitdiff"].includes(lower);
}

function toolStatus(metadata: Record<string, unknown>): MycliShellToolStatus {
	if (metadata.status === "running") return "running";
	if (metadata.status === "failed" || metadata.success === false) return "error";
	if (metadata.success === true || metadata.status === "done") return "success";
	return "running";
}

function durationMs(metadata: Record<string, unknown>): number | undefined {
	const ms = numberValue(metadata.duration_ms);
	if (ms !== null) return ms;
	const seconds = numberValue(metadata.duration_s);
	return seconds === null ? undefined : seconds * 1000;
}

function mutatingTool(name: string, metadata: Record<string, unknown>): boolean {
	const lower = name.toLowerCase();
	return lower.includes("edit") || lower.includes("write") || lower.includes("patch") || Array.isArray(metadata.file_changes);
}

function isShellTool(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === "bash" || lower === "shell" || lower === "run_shell";
}

function commandTargetPreview(name: string, target: string | null): string | null {
	if (!target || !isShellTool(name)) {
		return target;
	}
	const lines = target
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length <= 1) {
		return target;
	}
	const firstLine = lines[0] ?? "command";
	return `${firstLine} ... (${lines.length} lines)`;
}

function planStatus(metadata: unknown): "proposed" | "accepted" | "stale" {
	const status = stringValue(recordValue(metadata).status);
	return status === "accepted" || status === "stale" ? status : "proposed";
}

function planStepsFromEvent(params: Record<string, unknown>): MycliShellPlanStep[] {
	const richSteps = planStepsFromPlanObject(params.plan);
	if (richSteps.length > 0) {
		return richSteps;
	}
	return planStepsFromPayload(params.plan_steps);
}

function planStepsFromPlanObject(value: unknown): MycliShellPlanStep[] {
	const record = recordValue(value);
	const items = record.items;
	if (!Array.isArray(items)) return [];
	return items
		.map((item, index) => planStepFromRecord(recordValue(item), index))
		.filter((item): item is MycliShellPlanStep => item !== null);
}

function planStepsFromPayload(value: unknown): MycliShellPlanStep[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item, index) => planStepFromString(String(item), index))
		.filter((item): item is MycliShellPlanStep => item !== null);
}

function planStepFromRecord(record: Record<string, unknown>, index: number): MycliShellPlanStep | null {
	const text = stringValue(record.text) ?? stringValue(record.content) ?? stringValue(record.step);
	if (!text) return null;
	const evidence = stringArrayValue(record.evidence);
	return {
		id: stringValue(record.id) ?? `step-${index + 1}`,
		status: planStepStatus(stringValue(record.status) ?? undefined),
		text,
		...(evidence.length > 0 ? { evidence } : {}),
	};
}

function planStepFromString(value: string, index: number): MycliShellPlanStep | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const match = /^(pending|in_progress|completed)\s*:\s*(.+)$/i.exec(trimmed);
	const status = planStepStatus(match?.[1]);
	const text = (match?.[2] ?? trimmed).trim();
	if (!text) return null;
	return {
		id: `step-${index + 1}`,
		status,
		text,
	};
}

function planStepStatus(value: string | undefined): MycliShellPlanStep["status"] {
	if (value === "completed" || value === "in_progress") return value;
	return "pending";
}

function stringArrayValue(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) {
		return [value.trim()];
	}
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function reasoningForAssistant(item: RuntimeTranscriptItem, state: RuntimeShellState): string | undefined {
	if (item.id === state.activeAssistantItemId && state.liveReasoning?.text.trim()) {
		return state.liveReasoning.text;
	}
	return nearbyReasoningFor(item, state.transcript);
}

function nearbyReasoningFor(item: RuntimeTranscriptItem, items: RuntimeTranscriptItem[]): string | undefined {
	const index = items.indexOf(item);
	for (let cursor = Math.max(0, index - 2); cursor < index; cursor += 1) {
		const candidate = items[cursor];
		if (candidate?.type === "reasoning" && candidate.text.trim()) {
			return candidate.text;
		}
	}
	return undefined;
}

function applyAssistantDelta(items: RuntimeTranscriptItem[], assistantId: string, text: string): RuntimeTranscriptItem[] {
	const streamIndex = items.findIndex((item) => item.id === assistantId && item.type === "assistant_stream");
	if (streamIndex >= 0) {
		const item = items[streamIndex]!;
		return [...items.slice(0, streamIndex), { ...item, text: `${item.text}${text}` }, ...items.slice(streamIndex + 1)];
	}
	const finalIndex = items.findIndex((item) => item.id === assistantId && item.type === "assistant_final");
	if (finalIndex >= 0) {
		const item = items[finalIndex]!;
		return [...items.slice(0, finalIndex), { ...item, type: "assistant_stream", text: `${item.text}${text}` }, ...items.slice(finalIndex + 1)];
	}
	return [...items, { id: assistantId, type: "assistant_stream", text, folded: false, metadata: {} }];
}

function reconcileFinalAnswer(items: RuntimeTranscriptItem[], assistantId: string | null, answer: string): RuntimeTranscriptItem[] {
	const streamIndex =
		assistantId !== null
			? items.findIndex((item) => item.id === assistantId && item.type === "assistant_stream")
			: findLastIndex(items, (item) => item.type === "assistant_stream");
	if (!answer.trim()) {
		return streamIndex >= 0 ? [...items.slice(0, streamIndex), ...items.slice(streamIndex + 1)] : items;
	}
	const fallbackId = assistantId ?? nextId("assistant");
	const finalIndex = items.findIndex((item) => item.id === fallbackId && item.type === "assistant_final");
	const finalText = finalAnswerSuffix(items, streamIndex >= 0 ? streamIndex : finalIndex, answer);
	if (!finalText.trim()) {
		if (streamIndex >= 0) {
			return [...items.slice(0, streamIndex), ...items.slice(streamIndex + 1)];
		}
		return items;
	}
	const finalItem = {
		id: streamIndex >= 0 ? items[streamIndex]!.id : fallbackId,
		type: "assistant_final",
		text: finalText,
		folded: false,
		metadata: {},
	};
	if (finalIndex >= 0) {
		return [...items.slice(0, finalIndex), finalItem, ...items.slice(finalIndex + 1)];
	}
	return streamIndex >= 0 ? [...items.slice(0, streamIndex), finalItem, ...items.slice(streamIndex + 1)] : [...items, finalItem];
}

function sealAssistantStream(items: RuntimeTranscriptItem[], assistantId: string): RuntimeTranscriptItem[] {
	const streamIndex = items.findIndex((item) => item.id === assistantId && item.type === "assistant_stream");
	if (streamIndex < 0) {
		return items;
	}
	const item = items[streamIndex]!;
	if (!item.text.trim()) {
		return [...items.slice(0, streamIndex), ...items.slice(streamIndex + 1)];
	}
	return [
		...items.slice(0, streamIndex),
		{ ...item, type: "assistant_final", folded: false },
		...items.slice(streamIndex + 1),
	];
}

function sealActiveAssistantStream(items: RuntimeTranscriptItem[], assistantId: string | null): RuntimeTranscriptItem[] {
	return assistantId === null ? items : sealAssistantStream(items, assistantId);
}

function applyProposedPlan(items: RuntimeTranscriptItem[], params: Record<string, unknown>): RuntimeTranscriptItem[] {
	const text = String(params.text ?? "").trim();
	if (!text) return items;
	const clientTurnId = stringValue(params.client_turn_id) ?? "turn";
	const id = `plan:${clientTurnId}`;
	const item = {
		id,
		type: "proposed_plan",
		text,
		folded: false,
		metadata: { ...params, status: stringValue(params.status) ?? "proposed" },
	};
	const existingIndex = items.findIndex((candidate) => candidate.id === id || candidate.type === "proposed_plan");
	if (existingIndex >= 0) {
		return [...items.slice(0, existingIndex), item, ...items.slice(existingIndex + 1)];
	}
	return [...items, item];
}

function finalAnswerSuffix(items: RuntimeTranscriptItem[], replaceIndex: number, answer: string): string {
	const turnStart = findLastIndex(items, (item) => item.type === "user");
	const end = replaceIndex >= 0 ? replaceIndex : items.length;
	const visiblePrefix = items
		.slice(turnStart + 1, end)
		.filter((item) => item.type === "assistant_stream" || item.type === "assistant_final")
		.map((item) => item.text)
		.join("");
	if (!visiblePrefix || !answer.startsWith(visiblePrefix)) {
		return answer;
	}
	return answer.slice(visiblePrefix.length);
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (predicate(items[index]!)) {
			return index;
		}
	}
	return -1;
}

function applyReasoning(items: RuntimeTranscriptItem[], text: string, metadata: Record<string, unknown>): RuntimeTranscriptItem[] {
	const last = items.at(-1);
	const item = {
		id: last?.type === "reasoning" ? last.id : nextId("reasoning"),
		type: "reasoning",
		text,
		folded: true,
		metadata,
	};
	return last?.type === "reasoning" ? [...items.slice(0, -1), item] : [...items, item];
}

function applyToolLifecycle(items: RuntimeTranscriptItem[], method: string, params: Record<string, unknown>): RuntimeTranscriptItem[] {
	const metadata = {
		...params,
		tool_name: stringValue(params.name) ?? stringValue(params.tool_name) ?? "Tool",
		status: method === "tool.failed" ? "failed" : method === "tool.complete" ? "done" : "running",
	};
	const matchIndex = findToolIndex(items, metadata);
	const item = {
		id: matchIndex >= 0 ? items[matchIndex]!.id : nextId("tool"),
		type: "tool_summary",
		text: lifecycleToolText(metadata),
		folded: true,
		metadata: matchIndex >= 0 ? { ...recordValue(items[matchIndex]!.metadata), ...metadata } : metadata,
	};
	return matchIndex >= 0 ? [...items.slice(0, matchIndex), item, ...items.slice(matchIndex + 1)] : [...items, item];
}

function applyCompactionLifecycle(items: RuntimeTranscriptItem[], method: string, params: Record<string, unknown>): RuntimeTranscriptItem[] {
	const metadata = {
		...params,
		tool_id: compactionId(params),
		call_id: compactionId(params),
		tool_name: "Compact",
		name: "Compact",
		status:
			method === "compaction.started"
				? "running"
				: stringValue(params.status) === "failed"
					? "failed"
					: "done",
		summary: compactionSummary(method, params),
		context: stringValue(params.source) ?? "context",
	};
	const matchIndex = findToolIndex(items, metadata);
	const item = {
		id: matchIndex >= 0 ? items[matchIndex]!.id : nextId("compaction"),
		type: "tool_summary",
		text: compactionSummary(method, params),
		folded: true,
		metadata: matchIndex >= 0 ? { ...recordValue(items[matchIndex]!.metadata), ...metadata } : metadata,
	};
	return matchIndex >= 0 ? [...items.slice(0, matchIndex), item, ...items.slice(matchIndex + 1)] : [...items, item];
}

function upsertSubagentTranscriptItem(items: RuntimeTranscriptItem[], item: RuntimeTranscriptItem): RuntimeTranscriptItem[] {
	const existingIndex = items.findIndex((candidate) => candidate.id === item.id);
	if (existingIndex < 0) {
		return [...items, item];
	}
	const existing = items[existingIndex]!;
	const existingMetadata = recordValue(existing.metadata);
	const nextMetadata = recordValue(item.metadata);
	const progress = [
		...(Array.isArray(existingMetadata.progress) ? existingMetadata.progress : []),
		...(Array.isArray(nextMetadata.progress) ? nextMetadata.progress : []),
	].slice(-40);
	const merged: RuntimeTranscriptItem = {
		...existing,
		...item,
		text: item.text || existing.text,
		metadata: {
			...existingMetadata,
			...nextMetadata,
			progress,
		},
	};
	return [...items.slice(0, existingIndex), merged, ...items.slice(existingIndex + 1)];
}

function findToolIndex(items: RuntimeTranscriptItem[], metadata: Record<string, unknown>): number {
	const toolId = stringValue(metadata.tool_id);
	const callId = stringValue(metadata.call_id);
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.type !== "tool_summary") continue;
		const itemMetadata = recordValue(item.metadata);
		if (toolId && stringValue(itemMetadata.tool_id) === toolId) return index;
		if (callId && stringValue(itemMetadata.call_id) === callId) return index;
	}
	return -1;
}

function compactionId(params: Record<string, unknown>): string {
	return [
		"compaction",
		stringValue(params.client_turn_id) ?? "turn",
		stringValue(params.source) ?? "context",
	].join(":");
}

function compactionSummary(method: string, params: Record<string, unknown>): string {
	const before = numberValue(params.before_tokens);
	const after = numberValue(params.after_tokens);
	const duration = numberValue(params.duration_s);
	if (method === "compaction.started") {
		return before === null ? "Compressing context" : `Compressing context · ${formatTokens(before)} tokens`;
	}
	const durationText = duration === null ? "" : ` for ${formatSeconds(duration)}`;
	if (stringValue(params.status) === "failed") {
		return `Context compression failed${durationText}`;
	}
	if (stringValue(params.status) === "skipped") {
		return `Context compression skipped${durationText}`;
	}
	if (before !== null && after !== null) {
		return `Context compressed${durationText} · ${formatTokens(before)} -> ${formatTokens(after)} tokens`;
	}
	return `Context compressed${durationText}`;
}

function formatTokens(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatSeconds(value: number): string {
	const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
	return `${rounded} s`;
}

function lifecycleToolText(metadata: Record<string, unknown>): string {
	const name = stringValue(metadata.tool_name) ?? "Tool";
	const target =
		stringValue(metadata.path) ??
		stringValue(metadata.query) ??
		stringValue(metadata.command) ??
		stringValue(metadata.context) ??
		stringValue(metadata.summary) ??
		stringValue(metadata.args_preview);
	return target ? `${name} ${target}` : name;
}

function reasoningText(params: Record<string, unknown>): string {
	const format = stringValue(params.format) ?? stringValue(params.encoding);
	if (format && ["encrypted", "opaque", "binary"].includes(format.toLowerCase())) {
		const bytes = typeof params.bytes === "number" ? ` · ${params.bytes} bytes` : "";
		return `reasoning · ${format.toLowerCase()}${bytes}`;
	}
	return String(params.text ?? "reasoning · opaque");
}

function trustFromPayload(payload: unknown, workspace: string): RuntimeShellState["trust"] {
	const record = recordValue(payload);
	return {
		state: stringValue(record.state) ?? "unknown",
		workspace: stringValue(record.workspace) ?? workspace,
	};
}

function modelListFromStatus(status: Record<string, unknown>, provider: string, model: string): MycliShellModel[] {
	const raw = Array.isArray(status.models) ? status.models : Array.isArray(status.available_models) ? status.available_models : [];
	const models = raw.map(modelFromUnknown).filter((item): item is MycliShellModel => item !== null);
	if (models.length === 0 && model) {
		models.push(currentModel(provider, model, reasoningLevelFromStatus(status)));
	}
	return models;
}

function modelFromUnknown(value: unknown): MycliShellModel | null {
	const record = recordValue(value);
	const id = stringValue(record.id) ?? stringValue(record.model);
	if (!id) return null;
	return {
		id,
		provider: stringValue(record.provider) ?? "",
		name: stringValue(record.name) ?? undefined,
		thinkingLevel: stringValue(record.thinking_level) ?? stringValue(record.thinking_effort) ?? undefined,
		scoped: typeof record.scoped === "boolean" ? record.scoped : undefined,
	};
}

function authProvidersFromUnknown(value: unknown): MycliShellAuthProvider[] {
	if (!Array.isArray(value)) return [];
	return value.map(authProviderFromUnknown).filter((item): item is MycliShellAuthProvider => item !== null);
}

function authProviderFromUnknown(value: unknown): MycliShellAuthProvider | null {
	const record = recordValue(value);
	const id = stringValue(record.id) ?? stringValue(record.provider_id);
	if (!id) return null;
	return {
		id,
		name: stringValue(record.name) ?? id,
		configured: typeof record.configured === "boolean" ? record.configured : undefined,
		defaultModel: stringValue(record.default_model) ?? stringValue(record.defaultModel) ?? undefined,
	};
}

function resourceFromUnknown(value: unknown): MycliShellResource | null {
	const record = recordValue(value);
	const id = stringValue(record.id);
	const type = resourceTypeValue(record.type);
	const name = stringValue(record.name);
	if (!id || !type || !name) return null;
	return {
		id,
		type,
		name,
		source: resourceSourceValue(record.source) ?? undefined,
		enabled: booleanValue(record.enabled) ?? undefined,
		status: stringValue(record.status) ?? undefined,
		detail: stringValue(record.detail) ?? undefined,
		command: stringValue(record.command) ?? undefined,
	};
}

function currentModel(provider: string, model: string, thinkingLevel?: string): MycliShellModel {
	return { provider, id: model || "no-model", ...(thinkingLevel ? { thinkingLevel } : {}) };
}

function reasoningLevelFromStatus(status: Record<string, unknown>): string | undefined {
	return stringValue(status.thinking_effort) ?? stringValue(status.reasoning_effort) ?? undefined;
}

function usageFooterData(status: Record<string, unknown>): Partial<MycliShellState["footer"]> {
	const context = recordValue(status.context) || status;
	const usage = recordValue(status.usage) || status;
	return {
		contextPercent: numberValue(context.context_percent) ?? numberValue(context.percent) ?? undefined,
		contextWindow: numberValue(context.context_window) ?? numberValue(context.max_tokens) ?? undefined,
		totalInputTokens: numberValue(usage.input_tokens) ?? undefined,
		totalOutputTokens: numberValue(usage.output_tokens) ?? undefined,
		cacheReadTokens: numberValue(usage.cache_read_tokens) ?? undefined,
		cacheWriteTokens: numberValue(usage.cache_write_tokens) ?? undefined,
		costUsd: numberValue(usage.cost_usd) ?? undefined,
	};
}

function compactTarget(value: string | null, workspace: string): string | null {
	if (!value) return null;
	const normalizedWorkspace = workspace.replaceAll("\\", "/").replace(/\/+$/, "");
	const normalizedValue = value.replaceAll("\\", "/");
	if (normalizedWorkspace && normalizedValue.startsWith(`${normalizedWorkspace}/`)) {
		return normalizedValue.slice(normalizedWorkspace.length + 1);
	}
	return normalizedValue;
}

function isTranscriptItem(value: unknown): value is RuntimeTranscriptItem {
	const record = recordValue(value);
	return Boolean(stringValue(record.id) && stringValue(record.type) && typeof record.text === "string");
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function defaultVisualSettings(): Required<MycliShellVisualSettings> {
	return {
		statusbarMode: "full",
		viewMode: "default",
		theme: "dark",
		hideThinking: true,
		toolDetailsDefault: "collapsed",
		hardwareCursor: false,
		clearOnShrink: true,
		terminalProgress: true,
		subagentDensity: "normal",
	};
}

function normalizeVisualSettings(
	settings: MycliShellVisualSettings,
	fallback: MycliShellVisualSettings = defaultVisualSettings(),
): MycliShellVisualSettings {
	const raw = settings as Record<string, unknown>;
	return {
		statusbarMode: statusbarModeValue(raw.statusbarMode ?? raw.statusbar_mode) ?? fallback.statusbarMode ?? "full",
		viewMode: viewModeValue(raw.viewMode ?? raw.view_mode) ?? fallback.viewMode ?? "default",
		theme: stringValue(raw.theme) ?? fallback.theme ?? "dark",
		hideThinking: booleanValue(raw.hideThinking ?? raw.hide_thinking) ?? fallback.hideThinking ?? true,
		toolDetailsDefault:
			toolDetailsDefaultValue(raw.toolDetailsDefault ?? raw.tool_details_default) ?? fallback.toolDetailsDefault ?? "collapsed",
		hardwareCursor: booleanValue(raw.hardwareCursor ?? raw.hardware_cursor) ?? fallback.hardwareCursor ?? false,
		clearOnShrink: booleanValue(raw.clearOnShrink ?? raw.clear_on_shrink) ?? fallback.clearOnShrink ?? true,
		terminalProgress: booleanValue(raw.terminalProgress ?? raw.terminal_progress) ?? fallback.terminalProgress ?? true,
		subagentDensity: subagentDensityValue(raw.subagentDensity ?? raw.subagent_density) ?? fallback.subagentDensity ?? "normal",
	};
}

function statusbarModeValue(value: unknown): MycliShellVisualSettings["statusbarMode"] | null {
	return value === "off" || value === "compact" || value === "full" ? value : null;
}

function viewModeValue(value: unknown): MycliShellVisualSettings["viewMode"] | null {
	return value === "default" || value === "verbose" || value === "focus" ? value : null;
}

function toolDetailsDefaultValue(value: unknown): MycliShellVisualSettings["toolDetailsDefault"] | null {
	return value === "collapsed" || value === "expanded" ? value : null;
}

function subagentDensityValue(value: unknown): MycliShellVisualSettings["subagentDensity"] | null {
	return value === "compact" || value === "normal" || value === "detailed" ? value : null;
}

function resourceTypeValue(value: unknown): MycliShellResource["type"] | null {
	return value === "hook" || value === "plugin" || value === "skill" || value === "prompt" || value === "theme" ? value : null;
}

function resourceSourceValue(value: unknown): MycliShellResource["source"] | null {
	return value === "user" || value === "repo" || value === "builtin" || value === "package" || value === "runtime" || value === "unknown"
		? value
		: null;
}

function collaborationModeValue(value: unknown): RuntimeShellState["collaborationMode"] | null {
	return value === "default" || value === "plan" ? value : null;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let nextItemId = 1;

function nextId(prefix: string): string {
	return `${prefix}_${nextItemId++}`;
}
