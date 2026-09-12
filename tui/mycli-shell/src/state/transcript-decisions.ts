import type {
	MycliShellClarificationResponse,
	MycliShellPendingApproval,
	MycliShellPendingClarification,
} from "../model.ts";
import {
	booleanValue,
	generationValue,
	numberValue,
	recordValue,
	stringArrayValue,
	stringValue,
	textValue,
} from "./payload-values.ts";
import type { RuntimeShellState, RuntimeTranscriptItem } from "./runtime-state-model.ts";
import { diffPreviewForTool } from "./transcript-tools.ts";

export function pendingApprovalFromRecord(value: Record<string, unknown> | null): MycliShellPendingApproval | undefined {
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
		sessionId: stringValue(value.session_id) ?? stringValue(value.sessionId) ?? undefined,
		generation: numberValue(value.generation) ?? undefined,
		preview: stringValue(value.preview) ?? stringValue(value.action) ?? stringValue(value.tool_name) ?? "Approval required",
		commandPreview: textValue(value.command_preview) ?? textValue(value.commandPreview) ?? undefined,
		commandTruncated: booleanValue(value.command_truncated) ?? booleanValue(value.commandTruncated) ?? undefined,
		justification: stringValue(value.justification) ?? undefined,
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
		agentPath: stringValue(value.agent_path) ?? stringValue(value.agentPath) ?? undefined,
		options: options.length > 0 ? options : defaultApprovalOptions(),
		risk: stringValue(value.risk) ?? undefined,
		riskReason: stringValue(value.risk_reason) ?? stringValue(value.riskReason) ?? undefined,
		persistentRulePreview:
			stringValue(value.persistent_rule_preview) ?? stringValue(value.persistentRulePreview) ?? undefined,
		permissionRequest: permissionRequestFromPayload(
			value.permission_request ?? value.permissionRequest,
		),
		contentPreview: stringValue(value.content_preview) ?? stringValue(value.contentPreview) ?? undefined,
		contentLineCount: numberValue(value.content_line_count) ?? numberValue(value.contentLineCount) ?? undefined,
		diffPreview: diffPreviewForTool(value),
	};
}

function permissionRequestFromPayload(
	value: unknown,
): MycliShellPendingApproval["permissionRequest"] {
	const request = recordValue(value);
	if (Object.keys(request).length === 0) return undefined;
	const network = recordValue(request.network).enabled === true;
	const fileSystem = recordValue(request.file_system ?? request.fileSystem);
	const readPaths = stringArrayValue(fileSystem.read);
	const writePaths = stringArrayValue(fileSystem.write);
	if (!network && readPaths.length === 0 && writePaths.length === 0) return undefined;
	return { network, readPaths, writePaths };
}

export function pendingClarificationFromRecord(
	value: Record<string, unknown> | null,
): MycliShellPendingClarification | undefined {
	if (!value) {
		return undefined;
	}
	const requestId = stringValue(value.request_id) ?? stringValue(value.requestId);
	const question = stringValue(value.question);
	if (!requestId || !question) {
		return undefined;
	}
	const rawOptions = Array.isArray(value.options) ? value.options : [];
	const options: MycliShellPendingClarification["options"] = [];
	for (const item of rawOptions) {
		const record = recordValue(item);
		const label = stringValue(record.label);
		if (!label) continue;
		const description = stringValue(record.description);
		options.push({ label, ...(description ? { description } : {}) });
	}
	const turnId = stringValue(value.turn_id) ?? stringValue(value.turnId);
	return {
		requestId,
		...(value.elicitation ? { elicitation: value.elicitation as NonNullable<MycliShellPendingClarification["elicitation"]> } : {}),
		...(turnId ? { turnId } : {}),
		sessionId: stringValue(value.session_id) ?? stringValue(value.sessionId) ?? undefined,
		generation: numberValue(value.generation) ?? undefined,
		question,
		workerName: stringValue(value.worker_name) ?? stringValue(value.workerName) ?? undefined,
		childSessionId: stringValue(value.child_session_id) ?? stringValue(value.childSessionId) ?? undefined,
		agentPath: stringValue(value.agent_path) ?? stringValue(value.agentPath) ?? undefined,
		header: stringValue(value.header) ?? undefined,
		options,
		multiSelect: booleanValue(value.multi_select) ?? booleanValue(value.multiSelect) ?? false,
	};
}

export function clarificationResponseFromTranscriptItem(
	item: RuntimeTranscriptItem,
): MycliShellClarificationResponse | null {
	const metadata = recordValue(item.metadata);
	const requestId = stringValue(metadata.request_id) ?? stringValue(metadata.requestId);
	const question = stringValue(metadata.question);
	const response = stringValue(metadata.response);
	if (!requestId || !question || !response) return null;
	const header = stringValue(metadata.header);
	return {
		id: item.id,
		requestId,
		...(header ? { header } : {}),
		question,
		response,
		multiSelect: booleanValue(metadata.multi_select) ?? booleanValue(metadata.multiSelect) ?? false,
	};
}

export function clarificationResponseItemId(requestId: string): string {
	return `clarification-response:${requestId}`;
}

export function pendingRequestBelongsToDifferentTurn(
	pending: Record<string, unknown> | null,
	event: Record<string, unknown>,
): boolean {
	if (!pending) return false;
	const pendingSessionId = pendingRequestSessionId(pending);
	const eventSessionId = stringValue(event.session_id) ?? stringValue(event.sessionId);
	if (pendingSessionId && eventSessionId) return pendingSessionId !== eventSessionId;
	const pendingTurnId = stringValue(pending.client_turn_id) ?? stringValue(pending.clientTurnId);
	const eventTurnId = stringValue(event.client_turn_id) ?? stringValue(event.clientTurnId);
	if (pendingTurnId && eventTurnId) return pendingTurnId !== eventTurnId;
	return Boolean(
		stringValue(pending.child_session_id) ?? stringValue(pending.childSessionId),
	);
}

export function pendingRequestBelongsToStatusSession(
	pending: Record<string, unknown> | null,
	statusSessionId: string | undefined,
	activeSessionId: string | undefined,
): boolean {
	if (!pending) return false;
	const pendingSessionId = pendingRequestSessionId(pending);
	if (pendingSessionId && statusSessionId) return pendingSessionId === statusSessionId;
	if (pendingSessionId && activeSessionId) return pendingSessionId === activeSessionId;
	return true;
}

function pendingRequestSessionId(pending: Record<string, unknown> | null): string | undefined {
	if (!pending) return undefined;
	return stringValue(pending.session_id)
		?? stringValue(pending.sessionId)
		?? stringValue(pending.child_session_id)
		?? stringValue(pending.childSessionId)
		?? undefined;
}

export function interactiveResponseMatches(
	pending: Record<string, unknown> | null,
	response: Record<string, unknown>,
	snakeId: string,
	camelId: string,
): boolean {
	if (!pending) return false;
	const pendingId = stringValue(pending[snakeId]) ?? stringValue(pending[camelId]);
	const responseId = stringValue(response[snakeId]) ?? stringValue(response[camelId]);
	if (!pendingId || pendingId !== responseId) return false;
	const pendingSessionId = pendingRequestSessionId(pending);
	const responseSessionId = stringValue(response.session_id) ?? stringValue(response.sessionId);
	if (pendingSessionId && responseSessionId && pendingSessionId !== responseSessionId) return false;
	const pendingGeneration = generationValue(pending.generation);
	const responseGeneration = generationValue(response.generation);
	return pendingGeneration === null
		|| responseGeneration === null
		|| pendingGeneration === responseGeneration;
}

export function interactiveResponseTurnId(
	state: RuntimeShellState,
	pending: Record<string, unknown> | null,
	response: Record<string, unknown>,
): string | null {
	const pendingSessionId = pendingRequestSessionId(pending);
	const responseSessionId = stringValue(response.session_id) ?? stringValue(response.sessionId);
	const isRootSession = !pendingSessionId
		|| !state.sessionId
		|| pendingSessionId === state.sessionId
		|| responseSessionId === state.sessionId;
	return isRootSession
		? stringValue(response.turn_id) ?? stringValue(response.turnId) ?? state.activeTurnId
		: state.activeTurnId;
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

export function removeTransientApprovalItems(items: RuntimeTranscriptItem[], decisionId?: string): RuntimeTranscriptItem[] {
	return items.filter((item) => {
		if (item.type !== "approval") return true;
		if (!decisionId) return false;
		const metadata = recordValue(item.metadata);
		const itemDecisionId = stringValue(metadata.decision_id) ?? stringValue(metadata.decisionId);
		return itemDecisionId !== decisionId;
	});
}

export function removeTransientClarificationItems(items: RuntimeTranscriptItem[], requestId?: string): RuntimeTranscriptItem[] {
	return items.filter((item) => {
		if (item.type !== "clarification") return true;
		if (!requestId) return false;
		const metadata = recordValue(item.metadata);
		const itemRequestId = stringValue(metadata.request_id) ?? stringValue(metadata.requestId);
		return itemRequestId !== requestId;
	});
}
