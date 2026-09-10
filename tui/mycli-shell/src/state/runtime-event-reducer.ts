import {
	TURN_INTERRUPTED_NOTICE,
	projectTerminalInteraction,
	requestFailureNoticeId,
	sanitizeRuntimeErrorDetail,
	turnCompletedDurationId,
} from "@mycli/contracts";
import { boundedUiText } from "../safe-ui-text.ts";
import { modelCatalogFromPayload, trustFromPayload } from "./catalog-state.ts";
import { applyQueuePayload, cloneLocalInputsSnapshot, localInputsSnapshot } from "./input-queue.ts";
import {
	booleanValue,
	collaborationModeValue,
	generationValue,
	isInternalTaskNotification,
	nextId,
	numberValue,
	recordValue,
	stringValue,
	textValue,
	turnDurationMsValue,
} from "./payload-values.ts";
import { permissionStateFromUnknown } from "./permission-state.ts";
import { hasDurableAttemptForActiveTurn, mergeProviderAttemptHistory } from "./provider-attempts.ts";
import { runtimeEventBelongsToActiveOwner, runtimeEventTargetsChild } from "./runtime-event-ownership.ts";
import { decodeRuntimeEventInput, type DecodedRuntimeEvent } from "./runtime-events.ts";
import { reduceRuntimeLifecycle } from "./runtime-lifecycle-reducer.ts";
import type {
	RuntimeLocalUserInput,
	RuntimeShellState,
	RuntimeTranscriptItem,
} from "./runtime-state-model.ts";
import {
	activeClientTurnIdAfterTerminal,
	activeTurnIdAfterTerminal,
	eventBelongsToActiveSession,
	sessionChangeCanApply,
	statusSnapshotBelongsToActiveSession,
} from "./session-ownership.ts";
import {
	clarificationResponseItemId,
	interactiveResponseMatches,
	interactiveResponseTurnId,
	pendingRequestBelongsToDifferentTurn,
	pendingRequestBelongsToStatusSession,
	removeTransientApprovalItems,
	removeTransientClarificationItems,
} from "./transcript-decisions.ts";
import {
	appendErrorNotice,
	appendInterruptedNotice,
	appendTurnFailureNotice,
	applyAssistantDelta,
	applyCompactionLifecycle,
	applyProposedPlan,
	applyReasoning,
	commitCompletedWebSearchItems,
	finalizeFailedTools,
	finalizeInterruptedTools,
	finalizeTransientWebSearchItems,
	reasoningText,
	reconcileFinalAnswer,
	rollbackActiveAssistantAttempt,
	rollbackOutputFreeUserTurn,
	sealActiveAssistantStream,
	sealAssistantStream,
	turnFailureMessage,
	webSearchActionMetadata,
	webSearchDetail,
} from "./transcript-messages.ts";
import { planUpdateFromPayload, taskProgressFromPlanUpdate } from "./transcript-plans.ts";
import { upsertTranscriptItem } from "./transcript-records.ts";
import {
	activeTerminalWait,
	applyShellBootstrap,
	applyShellLifecycle,
	isEmptyWriteStdinPoll,
} from "./transcript-shell.ts";
import { transcriptItemFromSubagent, upsertSubagentTranscriptItem } from "./transcript-subagents.ts";
import {
	applyToolLifecycle,
	fileChangeEntriesFromUnknown,
	fileMutationTargetPreview,
	hasMatchingFileMutationProposal,
} from "./transcript-tools.ts";

export function reduceRuntimeEvent(
	state: RuntimeShellState,
	method: string,
	input: object,
): RuntimeShellState {
	const event = decodeRuntimeEventInput(method, input);
	return event ? reduceDecodedRuntimeEvent(state, event) : state;
}

export type RuntimeEventReduction = Readonly<{
	state: RuntimeShellState;
	applied: boolean;
}>;

export function reduceDecodedRuntimeEvent(
	state: RuntimeShellState,
	event: DecodedRuntimeEvent<string>,
): RuntimeShellState {
	return reduceDecodedRuntimeEventWithOutcome(state, event).state;
}

export function reduceDecodedRuntimeEventWithOutcome(
	state: RuntimeShellState,
	event: DecodedRuntimeEvent<string>,
): RuntimeEventReduction {
	if (!runtimeEventBelongsToActiveOwner(state, event)) {
		return { state, applied: false };
	}
	const nextState = reduceRuntimeLifecycle(
		state,
		reduceRuntimeEventUnchecked(state, event),
		event,
	);
	return { state: nextState, applied: nextState !== state };
}

function reduceRuntimeEventUnchecked(
	state: RuntimeShellState,
	event: DecodedRuntimeEvent<string>,
): RuntimeShellState {
	const { method } = event;
	const params = Object.fromEntries(Object.entries(event.params));
	if (method === "runtime.event") {
		const type = stringValue(params.type);
		const payload = recordValue(params.payload);
		return type ? reduceRuntimeEvent(state, type, payload) : state;
	}
	if (method.startsWith("shell.")) {
		return applyShellLifecycle(state, method, params);
	}
	if (method === "turn.started") {
		if (!eventBelongsToActiveSession(state, params)) return state;
		const preserveApproval = pendingRequestBelongsToDifferentTurn(state.pendingApproval, params);
		const preserveClarification = pendingRequestBelongsToDifferentTurn(
			state.pendingClarification,
			params,
		);
		return {
			...state,
			turnRunning: true,
			sessionGeneration: generationValue(params.generation) ?? state.sessionGeneration,
			activeTurnId: stringValue(params.turn_id) ?? state.activeTurnId,
			activeClientTurnId: stringValue(params.client_turn_id) ?? state.activeClientTurnId,
			activeAssistantItemId: nextId("assistant"),
			liveStatus: { state: "running", kind: "running", text: "Running" },
			retryRestoreStatus: null,
			pendingApproval: preserveApproval ? state.pendingApproval : null,
			pendingClarification: preserveClarification ? state.pendingClarification : null,
			transcript: preserveApproval || preserveClarification
				? state.transcript
				: removeTransientClarificationItems(removeTransientApprovalItems(state.transcript)),
		};
	}
	if (method === "item.started") {
		const item = recordValue(params.item);
		if (stringValue(item.type) === "web_search") {
			const itemId = stringValue(item.id);
			const callId = stringValue(item.call_id);
			if (!itemId || !callId) return state;
			const transcript = sealActiveAssistantStream(
				state.transcript,
				state.activeAssistantItemId,
			);
			return {
				...state,
				activeAssistantItemId: null,
				liveStatus: { state: "running", kind: "running", text: "Running" },
				transcript: upsertTranscriptItem(transcript, {
					id: itemId,
					type: "web_search",
					text: "",
					folded: false,
					call_id: callId,
					status: "running",
					metadata: { call_id: callId, status: "running", transient: true },
				}),
			};
		}
		if (stringValue(item.type) !== "file_change") return state;
		const itemId = stringValue(item.id);
		const callId = stringValue(item.call_id);
		const toolName = stringValue(item.name);
		const preview = stringValue(item.preview);
		if (!itemId || !callId || !toolName || !preview) return state;
		const target = fileMutationTargetPreview(preview, toolName);
		const contentLineCount = numberValue(item.content_line_count);
		const contentChars = numberValue(item.content_chars);
		const contentTruncated = booleanValue(item.content_truncated);
		const diffChars = numberValue(item.diff_chars);
		const diffTruncated = booleanValue(item.diff_truncated);
		const fileChanges = fileChangeEntriesFromUnknown(item.file_changes);
		const transcript = sealActiveAssistantStream(
			state.transcript,
			state.activeAssistantItemId,
		);
		return {
			...state,
			activeAssistantItemId: null,
			transcript: applyToolLifecycle(transcript, "file_mutation.started", {
				client_turn_id: params.client_turn_id,
				tool_id: itemId,
				call_id: callId,
				name: toolName,
				path: target,
				context: preview,
				args_preview: target,
				file_mutation_proposal: true,
				...(typeof item.content_preview === "string"
					? { content_preview: item.content_preview }
					: {}),
				...(contentLineCount === null
					? {}
					: { content_line_count: contentLineCount }),
				...(contentChars === null
					? {}
					: { content_chars: contentChars }),
				...(contentTruncated === null
					? {}
					: { content_truncated: contentTruncated }),
				...(typeof item.diff === "string" ? { diff: item.diff } : {}),
				...(diffChars === null
					? {}
					: { diff_chars: diffChars }),
				...(diffTruncated === null
					? {}
					: { diff_truncated: diffTruncated }),
				...(fileChanges.length > 0 ? { file_changes: fileChanges } : {}),
			}),
		};
	}
	if (method === "item.completed") {
		const item = recordValue(params.item);
		const itemId = stringValue(item.id);
		const itemType = stringValue(item.type);
		if (itemType === "web_search") {
			const callId = stringValue(item.call_id);
			if (!itemId || !callId) return state;
			const action = webSearchActionMetadata(item.action);
			return {
				...state,
				liveStatus: { state: "running", kind: "running", text: "Running" },
				transcript: upsertTranscriptItem(state.transcript, {
					id: itemId,
					type: "web_search",
					text: textValue(item.detail) ?? webSearchDetail(action),
					folded: false,
					call_id: callId,
					status: "completed",
					metadata: {
						call_id: callId,
						status: "completed",
						transient: true,
						...action,
					},
				}),
			};
		}
		const clientUserMessageId = stringValue(item.client_user_message_id);
		const content = textValue(item.content);
		if (
			itemType !== "user_message" ||
			!itemId ||
			!clientUserMessageId ||
			!content?.trim() ||
			isInternalTaskNotification(content)
		) {
			return state;
		}
		const withoutIdentity = (inputs: RuntimeLocalUserInput[]) =>
			inputs.filter((input) => input.clientUserMessageId !== clientUserMessageId);
		const transcript = state.transcript.some((entry) => entry.id === itemId)
			? state.transcript
			: [
				...sealActiveAssistantStream(state.transcript, state.activeAssistantItemId),
				{
					id: itemId,
					type: "user",
					text: content,
					folded: false,
					metadata: item,
				},
			];
		return {
			...state,
			activeAssistantItemId: null,
			localPendingSteers: withoutIdentity(state.localPendingSteers),
			localRejectedSteers: withoutIdentity(state.localRejectedSteers),
			localFollowUps: withoutIdentity(state.localFollowUps),
			localSubmittingMessages: withoutIdentity(state.localSubmittingMessages),
			transcript,
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
	if (method === "message.reset") {
		return rollbackActiveAssistantAttempt(state);
	}
	if (method === "stream.retrying") {
		if (hasDurableAttemptForActiveTurn(state)) return state;
		const text = boundedUiText(params.text, "Reconnecting...", 256);
		const additionalDetails = sanitizeRuntimeErrorDetail(params.additional_details);
		const retryRestoreStatus =
			state.liveStatus?.kind === "reconnecting"
				? state.retryRestoreStatus
				: state.liveStatus;
		return {
			...state,
			turnRunning: true,
			liveStatus: {
				state: "running",
				kind: "reconnecting",
				text,
				...(additionalDetails
					? { message: additionalDetails }
					: {}),
			},
			retryRestoreStatus,
		};
	}
	if (method === "stream.recovered") {
		if (hasDurableAttemptForActiveTurn(state)) return state;
		return {
			...state,
			liveStatus:
				state.retryRestoreStatus ??
				{ state: "running", kind: "running", text: "Running" },
			retryRestoreStatus: null,
		};
	}
	if (method === "provider.attempt.updated") {
		return mergeProviderAttemptHistory(state, [params.record], true);
	}
	if (method === "message.complete") {
		const text = String(params.text ?? "");
		const assistantId = state.activeAssistantItemId;
		return {
			...state,
			turnRunning: state.turnRunning,
			activeAssistantItemId: params.final === true ? null : state.activeAssistantItemId,
			liveReasoning: null,
			transcript: commitCompletedWebSearchItems(
				params.final === true
					? reconcileFinalAnswer(state.transcript, assistantId, text)
					: state.transcript,
			),
		};
	}
	if (method === "turn.event" && params.kind === "queued_message_committed") {
		const metadata = recordValue(params.metadata);
		const text = textValue(params.text);
		const queueId = stringValue(metadata.queue_id);
		if (
			!text?.trim()
			|| metadata.source === "task_notification"
			|| isInternalTaskNotification(text)
			|| (queueId && state.transcript.some((item) => stringValue(recordValue(item.metadata).queue_id) === queueId))
		) {
			return state;
		}
		return {
			...state,
			transcript: [
				...state.transcript,
				{
					id: queueId ? `queued_user_${queueId}` : nextId("queued-user"),
					type: "user",
					text,
					folded: false,
					metadata,
				},
			],
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
		const item = planUpdateFromPayload(params, nextId("plan-update"));
		if (!item) return state;
		return {
			...state,
			activeAssistantItemId: null,
			transcript: [
				...sealActiveAssistantStream(state.transcript, state.activeAssistantItemId),
				item,
			],
			taskProgress: taskProgressFromPlanUpdate(item),
		};
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
		const emptyShellPoll = method === "tool.start" && isEmptyWriteStdinPoll(params);
		const updatedTranscript = applyToolLifecycle(transcript, method, params);
		const interaction = projectTerminalInteraction(params.terminal_interaction ?? recordValue(params.tool_record).terminal_interaction);
		const activeWait = interaction?.kind === "poll" || state.liveStatus?.kind === "waiting_background_terminal"
			? activeTerminalWait(updatedTranscript) : undefined;
		const shellId = stringValue(params.shell_id) ?? stringValue(params.session_id);
		const waitingCommand = shellId ? state.backgroundShells[shellId]?.commandPreview : undefined;
		const leavingBackgroundWait =
			(method === "tool.complete" || method === "tool.failed") &&
			state.liveStatus?.kind === "waiting_background_terminal" &&
			(state.liveStatus.callId === undefined || state.liveStatus.callId === stringValue(params.call_id));
		return {
			...state,
			activeAssistantItemId: method === "tool.start" ? null : state.activeAssistantItemId,
			liveStatus: activeWait ?? (emptyShellPoll
				? {
					state: "running",
					kind: "waiting_background_terminal",
					text: "Waiting for background terminal",
					...(stringValue(params.call_id) ? { callId: stringValue(params.call_id)! } : {}),
					...(waitingCommand ? { message: waitingCommand } : {}),
				}
				: leavingBackgroundWait
					? { state: "running", kind: "running", text: "Running" }
					: state.liveStatus),
			transcript: updatedTranscript,
		};
	}
	if (method === "compaction.started" || method === "compaction.completed") {
		return {
			...state,
			turnRunning: true,
			liveStatus:
				method === "compaction.started"
					? { state: "running", kind: "compaction", text: "Compressing context" }
					: { state: "running", kind: "running", text: "Running" },
			transcript: applyCompactionLifecycle(state.transcript, method, params),
		};
	}
	if (method === "turn.completed") {
		const turnState = stringValue(params.turn_state);
		const durationMs = turnDurationMsValue(params.duration_ms);
		const inputRolledBack = params.input_rolled_back === true;
		const finalizedSearches = finalizeTransientWebSearchItems(state.transcript);
		const terminalTranscript =
			inputRolledBack
				? rollbackOutputFreeUserTurn(finalizedSearches)
				: turnState === "interrupted"
					? finalizeInterruptedTools(appendInterruptedNotice(finalizedSearches, params))
					: finalizedSearches;
		const preserveApproval = pendingRequestBelongsToDifferentTurn(state.pendingApproval, params);
		const preserveClarification = pendingRequestBelongsToDifferentTurn(
			state.pendingClarification,
			params,
		);
		const completedTurnIdentity = stringValue(params.turn_id)
			?? state.activeTurnId
			?? stringValue(params.client_turn_id);
		const transcriptWithDuration = (turnState === null || turnState === "completed")
			&& durationMs !== undefined
			&& completedTurnIdentity
			? upsertTranscriptItem(terminalTranscript, {
				id: turnCompletedDurationId(completedTurnIdentity),
				type: "turn_completed",
				text: "",
				folded: false,
				metadata: { duration_ms: durationMs },
			})
			: terminalTranscript;
		return {
			...state,
			turnRunning: false,
			activeTurnId: activeTurnIdAfterTerminal(state, params),
			activeClientTurnId: activeClientTurnIdAfterTerminal(state, params),
			activeAssistantItemId: null,
			liveReasoning: null,
			retryRestoreStatus: null,
			liveStatus:
				turnState === "interrupted"
					? {
						state: "interrupted",
						kind: "interrupted",
						text: "Interrupted",
						message: TURN_INTERRUPTED_NOTICE,
					}
					: turnState === "failed"
					? {
						state: "failed",
						kind: "failed",
						text: "Failed",
					}
					: {
						state: "completed",
						kind: "completed",
						text: "Completed",
						...(durationMs === undefined ? {} : { durationMs }),
					},
			pendingApproval: preserveApproval
				|| params.pending_decision === true
				|| params.turn_state === "waiting_approval"
				? state.pendingApproval
				: null,
			pendingClarification: preserveClarification
				|| params.turn_state === "waiting_clarification"
				? state.pendingClarification
				: null,
			transcript: transcriptWithDuration,
		};
	}
	if (method === "turn.status" || method === "status.update") {
		const terminalStatus = params.terminal === true
			|| ["completed", "failed", "interrupted", "rejected"].includes(
				stringValue(params.state) ?? "",
			);
		if (params.state === "failed") {
			return {
				...state,
				turnRunning: false,
				activeTurnId: activeTurnIdAfterTerminal(state, params),
				activeClientTurnId: activeClientTurnIdAfterTerminal(state, params),
				activeAssistantItemId: null,
				liveReasoning: null,
				retryRestoreStatus: null,
				liveStatus: {
					state: "failed",
					kind: stringValue(params.kind) ?? "failed",
					text: stringValue(params.text) ?? "Failed",
				},
				transcript: finalizeTransientWebSearchItems(state.transcript),
			};
		}
		const durationMs = turnDurationMsValue(params.duration_ms)
			?? (params.state === "completed" ? state.liveStatus?.durationMs : undefined);
		return {
			...state,
			turnRunning: params.state === "running" || params.state === "waiting_approval" || params.state === "waiting_clarification",
			activeTurnId: terminalStatus ? activeTurnIdAfterTerminal(state, params) : state.activeTurnId,
			activeClientTurnId: terminalStatus
				? activeClientTurnIdAfterTerminal(state, params)
				: state.activeClientTurnId,
			liveStatus: {
				state: stringValue(params.state) ?? "running",
				kind: stringValue(params.kind) ?? "status",
				text: stringValue(params.text) ?? stringValue(params.message) ?? "Running",
				...(stringValue(params.message) ? { message: stringValue(params.message)! } : {}),
				...(durationMs === undefined ? {} : { durationMs }),
			},
		};
	}
	if (method === "turn.interrupted") {
		const message = stringValue(params.message) ?? "Interrupt requested";
		if (params.requested === true) {
			return {
				...state,
				turnRunning: true,
				liveStatus: {
					state: "interrupting",
					kind: "interrupting",
					text: "Interrupting",
					message,
				},
				retryRestoreStatus: null,
			};
		}
		return {
			...state,
			turnRunning: false,
			activeTurnId: activeTurnIdAfterTerminal(state, params),
			activeClientTurnId: activeClientTurnIdAfterTerminal(state, params),
			activeAssistantItemId: null,
			liveReasoning: null,
			retryRestoreStatus: null,
			liveStatus: {
				state: "interrupted",
				kind: "interrupted",
				text: "Interrupted",
				message: TURN_INTERRUPTED_NOTICE,
			},
			transcript: finalizeInterruptedTools(appendInterruptedNotice(
				finalizeTransientWebSearchItems(state.transcript),
				params,
			)),
		};
	}
	if (method === "turn.failed" || method === "gateway.error") {
		// The response handler reconciles this race with status.inspect; avoid leaving
		// a misleading error row behind while the selector is being replaced or cleared.
		const staleInteractiveError = method === "gateway.error"
			&& (
				(params.code === "approval_not_pending"
					&& (state.pendingApproval !== null || state.liveStatus?.state === "waiting_approval"))
				|| (params.code === "clarification_not_pending"
					&& (state.pendingClarification !== null || state.liveStatus?.state === "waiting_clarification"))
			);
		if (staleInteractiveError) return state;
		const message = method === "turn.failed"
			? turnFailureMessage(params)
			: boundedUiText(params.message, "Request failed.");
		const previousWaitingStatus =
			method === "gateway.error" &&
			(state.liveStatus?.state === "waiting_approval" || state.liveStatus?.state === "waiting_clarification")
				? state.liveStatus
				: null;
		if (method === "gateway.error") {
			const occurrenceId = stringValue(params.occurrence_id);
			return {
				...state,
				liveStatus: previousWaitingStatus ?? state.liveStatus,
				transcript: appendErrorNotice(
					state.transcript,
					params,
					message,
					occurrenceId ? requestFailureNoticeId(occurrenceId) : undefined,
				),
			};
		}
		return {
			...state,
			turnRunning: false,
			activeTurnId: activeTurnIdAfterTerminal(state, params),
			activeClientTurnId: activeClientTurnIdAfterTerminal(state, params),
			activeAssistantItemId: null,
			liveReasoning: null,
			retryRestoreStatus: null,
			liveStatus: { state: "failed", kind: "failed", text: message, message },
			transcript: finalizeFailedTools(appendTurnFailureNotice(
				finalizeTransientWebSearchItems(state.transcript),
				params,
			), params),
		};
	}
	if (method === "approval.request" || method === "approval.pending") {
		const childRequest = runtimeEventTargetsChild(event);
		const transcript = childRequest
			? state.transcript
			: sealActiveAssistantStream(state.transcript, state.activeAssistantItemId);
		const duplicateRequest = interactiveResponseMatches(
			state.pendingApproval,
			params,
			"decision_id",
			"decisionId",
		);
		const hasMutationProposal = hasMatchingFileMutationProposal(transcript, params);
		return {
			...state,
			pendingApproval: params,
			turnRunning: childRequest ? state.turnRunning : false,
			activeAssistantItemId: childRequest ? state.activeAssistantItemId : null,
			liveStatus: childRequest
				? state.liveStatus
				: { state: "waiting_approval", kind: "approval", text: "Waiting approval" },
			transcript: duplicateRequest || hasMutationProposal
				? transcript
				: [
					...transcript,
					{ id: nextId("approval"), type: "approval", text: String(params.preview ?? "Approval required"), folded: false, metadata: params },
				],
		};
	}
	if (method === "approval.respond") {
		if (!interactiveResponseMatches(
			state.pendingApproval,
			params,
			"decision_id",
			"decisionId",
		)) return state;
		const pending = state.pendingApproval;
		const childResponse = runtimeEventTargetsChild(event);
		return {
			...state,
			pendingApproval: null,
			turnRunning: childResponse ? state.turnRunning : true,
			activeTurnId: childResponse
				? state.activeTurnId
				: interactiveResponseTurnId(state, pending, params),
			liveStatus: childResponse
				? state.liveStatus
				: { state: "running", kind: "running", text: "Running" },
			transcript: removeTransientApprovalItems(
				state.transcript,
				stringValue(params.decision_id) ?? stringValue(params.decisionId) ?? undefined,
			),
		};
	}
	if (method === "clarify.request") {
		const childRequest = runtimeEventTargetsChild(event);
		const duplicateRequest = interactiveResponseMatches(
			state.pendingClarification,
			params,
			"request_id",
			"requestId",
		);
		return {
			...state,
			pendingClarification: params,
			turnRunning: childRequest ? state.turnRunning : false,
			activeAssistantItemId: childRequest ? state.activeAssistantItemId : null,
			liveStatus: childRequest
				? state.liveStatus
				: { state: "waiting_clarification", kind: "clarification", text: "Waiting clarification" },
			transcript: duplicateRequest
				? state.transcript
				: [
					...state.transcript,
					{ id: nextId("clarification"), type: "clarification", text: String(params.question ?? "Clarification required"), folded: false, metadata: params },
				],
		};
	}
	if (method === "clarify.respond") {
		if (state.pendingClarification && !interactiveResponseMatches(
			state.pendingClarification,
			params,
			"request_id",
			"requestId",
		)) return state;
		const requestId = stringValue(params.request_id) ?? stringValue(params.requestId);
		const response = stringValue(params.response);
		const pending = state.pendingClarification;
		const childResponse = runtimeEventTargetsChild(event);
		const question = stringValue(params.question) ?? stringValue(pending?.question);
		const header = stringValue(params.header) ?? stringValue(pending?.header);
		const multiSelect = booleanValue(params.multi_select)
			?? booleanValue(pending?.multi_select)
			?? false;
		const resolved = requestId && question && response
			? {
				id: clarificationResponseItemId(requestId),
				type: "clarification",
				text: response,
				folded: false,
				metadata: {
					...recordValue(pending),
					...params,
					request_id: requestId,
					...(header ? { header } : {}),
					question,
					response,
					multi_select: multiSelect,
					status: "answered",
				},
			} satisfies RuntimeTranscriptItem
			: undefined;
		return {
			...state,
			pendingClarification: null,
			turnRunning: childResponse ? state.turnRunning : true,
			activeTurnId: childResponse
				? state.activeTurnId
				: interactiveResponseTurnId(state, pending, params),
			liveStatus: childResponse
				? state.liveStatus
				: { state: "running", kind: "running", text: "Running" },
			transcript: [
				...removeTransientClarificationItems(
					state.transcript,
					requestId ?? undefined,
				),
				...(resolved ? [resolved] : []),
			],
		};
	}
	if (method === "interactive.cancelled") {
		const approvalCancelled = interactiveResponseMatches(
			state.pendingApproval,
			params,
			"decision_id",
			"decisionId",
		);
		const clarificationCancelled = interactiveResponseMatches(
			state.pendingClarification,
			params,
			"request_id",
			"requestId",
		);
		if (!approvalCancelled && !clarificationCancelled) return state;
		const childCancellation = runtimeEventTargetsChild(event);
		return {
			...state,
			pendingApproval: approvalCancelled ? null : state.pendingApproval,
			pendingClarification: clarificationCancelled ? null : state.pendingClarification,
			turnRunning: childCancellation ? state.turnRunning : false,
			activeAssistantItemId: childCancellation ? state.activeAssistantItemId : null,
			liveStatus: childCancellation ? state.liveStatus : null,
			transcript: approvalCancelled
				? removeTransientApprovalItems(
					state.transcript,
					stringValue(params.decision_id) ?? stringValue(params.decisionId) ?? undefined,
				)
				: removeTransientClarificationItems(
					state.transcript,
					stringValue(params.request_id) ?? stringValue(params.requestId) ?? undefined,
				),
		};
	}
	if (method === "status.changed") {
		if (!statusSnapshotBelongsToActiveSession(state, params)) return state;
		const trust = trustFromPayload(params.trust, state.workspace);
		const turnRunning = booleanValue(params.turn_running);
		const statusSessionId = stringValue(params.session_id) ?? stringValue(params.sessionId) ?? undefined;
		const clearApproval = params.pending_decision === false
			&& pendingRequestBelongsToStatusSession(state.pendingApproval, statusSessionId, state.sessionId ?? undefined);
		const clearClarification = params.suspended_turn === false
			&& pendingRequestBelongsToStatusSession(state.pendingClarification, statusSessionId, state.sessionId ?? undefined);
		const approvalDecisionId = clearApproval
			? stringValue(state.pendingApproval?.decision_id)
				?? stringValue(state.pendingApproval?.decisionId)
				?? undefined
			: undefined;
		const clarificationRequestId = clearClarification
			? stringValue(state.pendingClarification?.request_id)
				?? stringValue(state.pendingClarification?.requestId)
				?? undefined
			: undefined;
		const model = stringValue(params.model) ?? state.model;
		const provider = stringValue(params.provider) ?? state.provider;
		const nextState = applyQueuePayload({
			...state,
			status: params,
			sessionGeneration: generationValue(params.generation) ?? state.sessionGeneration,
			models: modelCatalogFromPayload(params) ?? state.models,
			turnRunning: turnRunning ?? state.turnRunning,
			activeTurnId:
				turnRunning === false
					? null
					: stringValue(params.turn_id) ?? state.activeTurnId,
			activeClientTurnId:
				turnRunning === false
					? null
					: stringValue(params.client_turn_id) ?? state.activeClientTurnId,
			activeAssistantItemId: turnRunning === false ? null : state.activeAssistantItemId,
			liveReasoning: turnRunning === false ? null : state.liveReasoning,
			liveStatus:
				turnRunning === false && state.liveStatus?.state === "interrupting"
					? null
					: state.liveStatus,
			sessionTitle: stringValue(params.session_title) ?? state.sessionTitle,
			model,
			collaborationMode: collaborationModeValue(params.collaboration_mode) ?? state.collaborationMode,
			provider,
			permissions: permissionStateFromUnknown(params.permissions) ?? state.permissions,
			trust,
			trustGateDismissed: trust.state === "trusted",
		}, params, "status");
		let transcript = nextState.transcript;
		if (clearApproval) transcript = removeTransientApprovalItems(transcript, approvalDecisionId);
		if (clearClarification) transcript = removeTransientClarificationItems(transcript, clarificationRequestId);
		return applyShellBootstrap({
			...nextState,
			pendingApproval: clearApproval ? null : nextState.pendingApproval,
			pendingClarification: clearClarification ? null : nextState.pendingClarification,
			liveStatus:
				!nextState.turnRunning
					&& ((clearApproval && nextState.liveStatus?.state === "waiting_approval")
						|| (clearClarification && nextState.liveStatus?.state === "waiting_clarification"))
					? null
					: nextState.liveStatus,
			transcript,
		}, params.background_shells);
	}
	if (method === "workspace.trust.changed") {
		const workspace = stringValue(params.workspace);
		if (workspace !== null && workspace !== state.workspace) return state;
		const trust = trustFromPayload(params, state.workspace);
		return { ...state, trust, trustGateDismissed: trust.state === "trusted" };
	}
	if (method === "turn.queue.updated") {
		if (!eventBelongsToActiveSession(state, params)) return state;
		return applyQueuePayload(state, params, "event");
	}
	if (method === "session.changed") {
		const nextSessionId = stringValue(params.session_id) ?? state.sessionId;
		const nextGeneration = generationValue(params.generation);
		if (!sessionChangeCanApply(state, nextSessionId, nextGeneration)) return state;
		const sessionLocalInputs = state.sessionId
			? {
				...state.sessionLocalInputs,
				[state.sessionId]: localInputsSnapshot(state),
			}
			: state.sessionLocalInputs;
		const restoredLocalInputs = nextSessionId
			? cloneLocalInputsSnapshot(sessionLocalInputs[nextSessionId])
			: cloneLocalInputsSnapshot();
		return {
			...state,
			sessionId: nextSessionId,
			sessionGeneration: nextGeneration ?? state.sessionGeneration,
			sessionTitle: stringValue(params.session_title) ?? state.sessionTitle,
			pendingApproval: null,
			pendingClarification: null,
			turnRunning: false,
			activeTurnId: null,
			activeClientTurnId: null,
			activeAssistantItemId: null,
			liveStatus: null,
			liveReasoning: null,
			taskProgress: null,
			transcriptNextBefore: null,
			providerAttemptsNextBefore: null,
			status: {},
			queueRevision: 0,
			queuedInputs: [],
			queuedPendingSteers: [],
			queuedRejectedSteers: [],
			queuedFollowUpInputs: [],
			...restoredLocalInputs,
			sessionLocalInputs,
			hasPendingInput: false,
			queueActivity: null,
			retryRestoreStatus: null,
			backgroundShells: {},
			backgroundShellCount: 0,
			shellEventSequences: {},
			transcript: [],
		};
	}
	return state;
}
