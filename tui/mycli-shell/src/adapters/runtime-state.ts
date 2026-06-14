import type {
	MycliShellBash,
	MycliShellMessage,
	MycliShellModel,
	MycliShellPlanStep,
	MycliShellSession,
	MycliShellState,
	MycliShellTranscriptBlock,
	MycliShellTool,
	MycliShellToolStatus,
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
	liveStatus: { state: string; text: string; kind?: string; message?: string } | null;
	liveReasoning: { text: string; kind: string } | null;
	viewMode: "default" | "verbose" | "focus";
	statusbarMode: "off" | "compact" | "full";
	pendingApproval: Record<string, unknown> | null;
	pendingClarification: Record<string, unknown> | null;
	activePlan: MycliShellPlanStep[];
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
		liveStatus: null,
		liveReasoning: null,
		viewMode: "default",
		statusbarMode: "full",
		pendingApproval: null,
		pendingClarification: null,
		activePlan: [],
	};
}

export function projectRuntimeState(state: RuntimeShellState, sessions: MycliShellSession[] = []): MycliShellState {
	const messages: MycliShellMessage[] = [];
	const tools: MycliShellTool[] = [];
	const bash: MycliShellBash[] = [];
	const transcript: MycliShellTranscriptBlock[] = [];

	for (const item of state.transcript) {
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
			const tool = toolFromTranscriptItem(item, state.workspace, state.viewMode);
			if (tool.name.toLowerCase() === "bash" || tool.name.toLowerCase() === "shell") {
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
			queueCount: state.queuedInputs.length,
			trust: state.trust.state ?? "unknown",
			collaborationMode: state.collaborationMode,
			liveState: state.liveStatus?.text ?? (state.turnRunning ? "Running" : state.collaborationMode === "plan" ? "Plan" : "Idle"),
			autoCompact: true,
		},
		pendingNotice: pendingNotice(state),
		models: modelListFromStatus(state.status, state.provider, state.model),
		currentModel: currentModel(state.provider, state.model, reasoningLevelFromStatus(state.status)),
		settings: {
			viewMode: state.viewMode,
			statusbarMode: state.statusbarMode,
			hideThinking: true,
		},
		sessions,
	};
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
			activePlan: planSteps.length > 0 ? planSteps : state.activePlan,
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
		return {
			...state,
			status: params,
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

function sessionFromUnknown(value: unknown): MycliShellSession | null {
	const record = recordValue(value);
	const id = stringValue(record.id) ?? stringValue(record.session_id) ?? stringValue(record.path);
	if (!id) return null;
	return {
		id,
		title: stringValue(record.title) ?? stringValue(record.name) ?? undefined,
		cwd: stringValue(record.cwd) ?? stringValue(record.workspace) ?? undefined,
		modified: stringValue(record.modified) ?? stringValue(record.updated_at) ?? undefined,
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

function toolFromTranscriptItem(item: RuntimeTranscriptItem, workspace: string, viewMode: RuntimeShellState["viewMode"]): MycliShellTool {
	const metadata = recordValue(item.metadata);
	const status = toolStatus(metadata);
	const name = stringValue(metadata.tool_name) ?? stringValue(metadata.name) ?? item.text.split(/\s+/, 1)[0] ?? "Tool";
	const target =
		stringValue(metadata.path) ??
		stringValue(metadata.command) ??
		stringValue(metadata.query) ??
		stringValue(metadata.context) ??
		stringValue(metadata.args_preview) ??
		item.text.replace(new RegExp(`^${escapeRegExp(name)}\\s*`), "");
	const outputPreview = stringValue(metadata.summary) ?? (status === "success" ? item.text : undefined);
	const errorPreview = stringValue(metadata.error) ?? (status === "error" ? item.text : undefined);
	return {
		id: item.id,
		name,
		args: compactTarget(target, workspace) ?? undefined,
		status,
		durationMs: durationMs(metadata),
		mutating: mutatingTool(name, metadata),
		hidden: shouldHideTool(name, status, mutatingTool(name, metadata), viewMode),
		outputPreview,
		errorPreview,
		hiddenLineCount: metadata.summary_truncated === true || metadata.error_truncated === true ? 1 : undefined,
		expanded: item.folded === false,
	};
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
