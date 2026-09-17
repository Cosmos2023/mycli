import { mcpStartupStatus } from "./extension-feedback.ts";
import { parseSessionGoal } from "@mycli/contracts";
import { isRuntimeErrorCode, runtimeErrorNoticeSeverity } from "@mycli/contracts";
import {
	hasProviderAttemptRetries,
	type MycliShellBash,
	type MycliShellMessage,
	type MycliShellSession,
	type MycliShellState,
	type MycliShellTool,
	type MycliShellTranscriptBlock,
} from "../model.ts";
import { currentModel } from "./catalog-state.ts";
import { commandResultFromTranscriptItem } from "./command-results.ts";
import { projectedQueueInputs } from "./input-queue.ts";
import {
	booleanValue,
	isInternalTaskNotification,
	numberValue,
	recordValue,
	stringValue,
	turnDurationMsValue,
} from "./payload-values.ts";
import type { RuntimeShellState, RuntimeTranscriptItem } from "./runtime-state-model.ts";
import {
	RuntimeTranscriptProjector,
	type RuntimeTranscriptProjection,
} from "./runtime-transcript-projector.ts";
import {
	clarificationResponseFromTranscriptItem,
	pendingApprovalFromRecord,
	pendingClarificationFromRecord,
} from "./transcript-decisions.ts";
import { diagnosticFromTranscriptItem } from "./transcript-diagnostics.ts";
import { noticeDiagnostic, webSearchFromTranscriptItem } from "./transcript-messages.ts";
import { planStatus, planUpdateFromTranscriptItem } from "./transcript-plans.ts";
import { backgroundTerminalsFromTranscriptItem, toolRecordFromTranscriptItem } from "./transcript-records.ts";
import { subagentFromTranscriptItem } from "./transcript-subagents.ts";
import {
	fileChangeFallbackText,
	fileChangeFromTranscriptItem,
	suppressGenericToolRow,
	toolFromTranscriptItem,
} from "./transcript-tools.ts";

/** Binds the incremental projection cache to the runtime-to-view mapping. */
export class RuntimeStateProjector extends RuntimeTranscriptProjector {
	constructor() {
		super(projectRuntimeShellState);
	}
}

export function projectRuntimeState(state: RuntimeShellState, sessions: MycliShellSession[] = []): MycliShellState {
	return projectRuntimeShellState(state, sessions);
}

function projectRuntimeShellState(
	state: RuntimeShellState,
	sessions: MycliShellSession[] = [],
	projectedTranscript?: RuntimeTranscriptProjection,
	sourceStart = 0,
): MycliShellState {
	const messages: MycliShellMessage[] = projectedTranscript?.messages ?? [];
	const tools: MycliShellTool[] = projectedTranscript?.tools ?? [];
	const bash: MycliShellBash[] = projectedTranscript?.bash ?? [];
	const transcript: MycliShellTranscriptBlock[] = projectedTranscript?.transcript ?? [];
	const { pendingSteers, rejectedSteers, followUps } = projectedQueueInputs(state);
	const queueCount = pendingSteers.length + rejectedSteers.length + followUps.length;

	for (
		let transcriptIndex = projectedTranscript ? state.transcript.length : sourceStart;
		transcriptIndex < state.transcript.length;
		transcriptIndex += 1
	) {
		const item = state.transcript[transcriptIndex]!;
		if (isInternalTaskNotification(item.text)) {
			continue;
		}
		if (
			state.turnRunning &&
			booleanValue(recordValue(item.metadata).deferred_until_turn_complete) === true
		) {
			continue;
		}
		if (item.type === "provider_attempt" && item.providerAttempts?.length) {
			const records = item.providerAttempts;
			if (records.some((record) => record.state !== "started" && record.state !== "completed"
				&& (record.state !== "cancelled" || record.failure?.code !== "interrupted" || hasProviderAttemptRetries(record)))) {
				transcript.push({ id: item.id, kind: "provider_attempt", providerAttempt: {
					records, expanded: item.folded === false,
					active: state.turnRunning && state.activeTurnId === records.at(-1)?.turnId,
				} });
			}
		} else if (item.type === "user") {
			const message: MycliShellMessage = { id: item.id, role: "user", text: item.text };
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "assistant_stream" || item.type === "assistant_final") {
			const thinking = reasoningForAssistant(item, transcriptIndex, state);
			const message: MycliShellMessage = {
				id: item.id,
				role: "assistant",
				text: item.text,
				...(thinking ? { thinking, thinkingHidden: true } : {}),
			};
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "turn_completed") {
			const durationMs = turnDurationMsValue(recordValue(item.metadata).duration_ms);
			if (durationMs !== undefined) {
				transcript.push({
					id: item.id,
					kind: "turn_completed",
					turnCompleted: { id: item.id, durationMs },
				});
			}
		} else if (item.type === "web_search") {
			const webSearch = webSearchFromTranscriptItem(item);
			if (webSearch) {
				transcript.push({ id: item.id, kind: "web_search", webSearch });
			}
		} else if (item.type === "warning") {
			const message: MycliShellMessage = {
				id: item.id,
				role: "warning",
				text: item.text,
				...noticeDiagnostic(item.metadata),
			};
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "error") {
			const code = stringValue(recordValue(item.metadata).code);
			const message: MycliShellMessage = {
				id: item.id,
				role: code && isRuntimeErrorCode(code)
					? runtimeErrorNoticeSeverity(code)
					: "error",
				text: item.text,
				...noticeDiagnostic(item.metadata),
			};
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "clarification") {
			const clarification = clarificationResponseFromTranscriptItem(item);
			if (clarification) {
				transcript.push({ id: item.id, kind: "clarification", clarification });
			} else {
				const message: MycliShellMessage = { id: item.id, role: "system", text: item.text };
				messages.push(message);
				transcript.push({ id: item.id, kind: "message", message });
			}
		} else if (item.type === "system_notice" || item.type === "command_output" || item.type === "approval") {
			const message: MycliShellMessage = { id: item.id, role: "system", text: item.text };
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "command_result") {
			const commandResult = commandResultFromTranscriptItem(item);
			if (commandResult) {
				transcript.push({ id: item.id, kind: "command_result", commandResult });
			}
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
		} else if (item.type === "plan_update") {
			const planUpdate = planUpdateFromTranscriptItem(item);
			if (planUpdate) {
				transcript.push({ id: item.id, kind: "plan_update", planUpdate });
			}
		} else if (item.type === "tool_summary" || item.type === "tool_detail") {
			const fileChange = fileChangeFromTranscriptItem(item);
			if (fileChange) {
				transcript.push({
					id: item.id,
					kind: "file_change",
					fileChange,
					message: {
						id: item.id,
						role: fileChange.status === "error" ? "error" : "system",
						text: fileChangeFallbackText(fileChange),
					},
				});
				continue;
			}
			const record = toolRecordFromTranscriptItem(item);
			const tool = toolFromTranscriptItem(item, record, state.workspace, state.settings.toolDetailsDefault);
			if (suppressGenericToolRow(tool)) {
				continue;
			}
			if (record.shell) {
				const shell = record.shell;
				const bashItem: MycliShellBash = {
					id: tool.id,
					toolName: tool.name,
					command: shell.command_preview ?? tool.args ?? tool.name,
					description: shell.description,
					status: tool.status,
					shellId: shell.shell_id,
					callId: record.call_id,
					background: shell.background,
					processState: shell.process_state,
					transport: shell.transport,
					tty: shell.tty,
					yielded: shell.yielded,
					terminalState: shell.terminal_state,
					exitCode: shell.exit_code,
					sequence: shell.sequence,
					startedAt: shell.started_at,
					completedAt: shell.completed_at,
					outputChars: shell.output_chars,
					omittedOutputChars: shell.omitted_output_chars,
					cleanupResult: shell.cleanup_result,
					shellKind: shell.shell_kind,
					shellEdition: shell.shell_edition,
					outputPreview: tool.detailPreview ?? tool.outputPreview,
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
		} else if (item.type === "command_diagnostic") {
			const diagnostic = diagnosticFromTranscriptItem(item);
			if (diagnostic) {
				transcript.push({ id: item.id, kind: "diagnostic", diagnostic });
			}
		} else if (item.type === "background_terminals") {
			const backgroundTerminals = backgroundTerminalsFromTranscriptItem(item);
			if (backgroundTerminals) {
				transcript.push({ id: item.id, kind: "background_terminals", backgroundTerminals });
			}
		}
	}

	return {
		...(state.sessionId ? { sessionId: state.sessionId } : {}),
		title: "mycli",
		messages,
		tools,
		bash,
		transcript,
		transcriptNextBefore: state.transcriptNextBefore,
		providerAttemptsNextBefore: state.providerAttemptsNextBefore,
		pendingInput:
			pendingSteers.length > 0 || rejectedSteers.length > 0 || followUps.length > 0
				? { pendingSteers, rejectedSteers, followUps }
				: undefined,
		footer: {
			extensionStatuses: mcpStartupStatus(state.resources),
			goal: state.status.goal ? parseSessionGoal(state.status.goal) : null,
			cwd: state.workspace || process.cwd(),
			sessionName: state.sessionTitle ?? state.sessionId ?? undefined,
			provider: state.provider || undefined,
			model: state.model || undefined,
			reasoningLevel: reasoningLevelFromStatus(state.status),
			...usageFooterData(state.status),
				queueCount,
				steeringQueueCount: pendingSteers.length,
				followUpQueueCount: rejectedSteers.length + followUps.length,
				hasPendingInput: queueCount > 0,
				queueActivity: state.queueActivity?.kind ?? (queueCount > 0 ? "pending_input" : "idle"),
			trust: state.trust.state ?? "unknown",
			collaborationMode: state.collaborationMode,
			operationRunning: state.activeCompaction !== null,
			liveOperationId: state.activeCompaction?.id,
			liveState: state.activeCompaction?.text ?? (Object.values(state.activeHooks).length ? `Running ${Object.values(state.activeHooks)[0]!.replaceAll("_", " ")} hooks` : footerLiveState(state)),
			liveStateKind: state.activeCompaction ? (state.activeCompaction.cancelling ? "interrupting" : "compaction") : Object.keys(state.activeHooks).length ? "hook" : state.liveStatus?.kind ?? state.liveStatus?.state,
			liveStateDetail: state.activeCompaction ? "Making room to continue." : state.liveStatus?.message,
			liveRetryAt: state.liveStatus?.retryAt,
			turnDurationMs: state.liveStatus?.durationMs,
			turnRunning: state.turnRunning,
			backgroundShellCount: state.backgroundShellCount,
			taskProgress: state.taskProgress ?? undefined,
			autoCompact: true,
		},
		pendingNotice: pendingNotice(state),
		pendingApproval: pendingApprovalFromRecord(state.pendingApproval),
		pendingClarification: pendingClarificationFromRecord(state.pendingClarification),
		models: state.models
			?? (state.model
				? [currentModel(state.provider, state.model, reasoningLevelFromStatus(state.status))]
				: []),
		modelsProvider: state.modelsProvider ?? undefined,
		providerRoutes: state.providerRoutes,
		authProviders: state.authProviders,
		authReadiness: state.authReadiness ?? undefined,
		currentModel: currentModel(state.provider, state.model, reasoningLevelFromStatus(state.status)),
		settings: {
			...state.settings,
			viewMode: state.viewMode,
			statusbarMode: state.statusbarMode,
		},
		settingsCatalog: state.settingsCatalog ?? undefined,
		keymap: state.keymap ?? undefined,
		terminalCapabilities: state.terminalCapabilities ?? undefined,
		sessions,
		resources: state.resources,
		permissions: state.permissions ?? undefined,
	};
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
		return "Idle";
	}
	if (liveStatusKind === "completed") {
		return "Completed";
	}
	if (state.collaborationMode === "plan") {
		return "Plan";
	}
	return "Idle";
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

function reasoningForAssistant(
	item: RuntimeTranscriptItem,
	itemIndex: number,
	state: RuntimeShellState,
): string | undefined {
	if (item.id === state.activeAssistantItemId && state.liveReasoning?.text.trim()) {
		return state.liveReasoning.text;
	}
	return nearbyReasoningFor(itemIndex, state.transcript);
}

function nearbyReasoningFor(itemIndex: number, items: RuntimeTranscriptItem[]): string | undefined {
	for (let cursor = Math.max(0, itemIndex - 2); cursor < itemIndex; cursor += 1) {
		const candidate = items[cursor];
		if (candidate?.type === "reasoning" && candidate.text.trim()) {
			return candidate.text;
		}
	}
	return undefined;
}

function reasoningLevelFromStatus(status: Record<string, unknown>): string | undefined {
	return stringValue(status.thinking_effort) ?? stringValue(status.reasoning_effort) ?? undefined;
}

function usageFooterData(status: Record<string, unknown>): Partial<MycliShellState["footer"]> {
	const nestedContext = recordValue(status.context);
	const canonicalContext = recordValue(status.context_window);
	const context = Object.keys(nestedContext).length > 0
		? nestedContext
		: Object.keys(canonicalContext).length > 0
			? canonicalContext
			: status;
	const nestedUsage = recordValue(status.usage);
	const usage = Object.keys(nestedUsage).length > 0 ? nestedUsage : status;
	const rawUsedTokens = numberValue(context.used_tokens);
	const rawMaxTokens = numberValue(context.max_tokens);
	const usedTokens = rawUsedTokens === null ? null : Math.max(0, rawUsedTokens);
	const maxTokens = rawMaxTokens === null ? null : Math.max(0, rawMaxTokens);
	const rawContextWindow = numberValue(context.context_window);
	const explicitPercent = numberValue(context.context_percent) ?? numberValue(context.percent);
	const usageRatio = numberValue(context.usage_ratio);
	const derivedPercent = explicitPercent
		?? (usageRatio === null ? null : usageRatio * 100)
		?? (usedTokens !== null && maxTokens !== null && maxTokens > 0
			? usedTokens / maxTokens * 100
			: null);
	return {
		contextPercent: derivedPercent === null
			? undefined
			: Math.min(100, Math.max(0, derivedPercent)),
		contextWindow: rawContextWindow === null
			? maxTokens ?? undefined
			: Math.max(0, rawContextWindow),
		contextUsedTokens: usedTokens ?? undefined,
		contextSource: stringValue(context.source) ?? undefined,
		totalInputTokens: numberValue(usage.input_tokens) ?? undefined,
		totalOutputTokens: numberValue(usage.output_tokens) ?? undefined,
		cacheReadTokens: numberValue(usage.cache_read_tokens) ?? undefined,
		cacheWriteTokens: numberValue(usage.cache_write_tokens) ?? undefined,
		costUsd: numberValue(usage.cost_usd) ?? undefined,
	};
}
