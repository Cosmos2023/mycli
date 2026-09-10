import type { RuntimeEvent } from "@mycli/core";
import type { GatewayTerminalInteraction } from "@mycli/contracts";
import type { ToolExecutionResult } from "@mycli/tools";
import {
	publishRuntimeDiagnostic,
	type RuntimeDiagnosticEvent,
} from "../runtime-observability.ts";

export interface ActiveToolExecutionInput {
	readonly turnId: string;
	readonly callId: string;
	readonly toolName: string;
	readonly terminalInteraction?: GatewayTerminalInteraction;
	readonly interruptErrorKind: "effect_outcome_unknown" | "tool_interrupted";
}

export interface ActiveToolExecutionClaim {
	readonly turnId: string;
	readonly trackingCallId: string;
	readonly callId: string;
	readonly toolName: string;
	readonly terminalInteraction?: GatewayTerminalInteraction;
	readonly signal: AbortSignal;
	readonly startedAt: number;
	readonly interruptErrorKind: ActiveToolExecutionInput["interruptErrorKind"];
}

export interface ActiveToolExecutionRegistryOptions {
	readonly clock?: () => number;
	readonly recordDiagnostic?: (event: RuntimeDiagnosticEvent) => void;
}

interface ActiveToolExecutionRecord {
	readonly claim: ActiveToolExecutionClaim;
	readonly abortController: AbortController;
	terminalEmitted: boolean;
}

export class ActiveToolExecutionRegistry {
	readonly #clock: () => number;
	readonly #recordDiagnostic: ActiveToolExecutionRegistryOptions["recordDiagnostic"];
	readonly #activeByTurn = new Map<string, Map<string, ActiveToolExecutionRecord>>();
	readonly #records = new WeakMap<ActiveToolExecutionClaim, ActiveToolExecutionRecord>();

	constructor(options: ActiveToolExecutionRegistryOptions = {}) {
		this.#clock = options.clock ?? (() => performance.now());
		this.#recordDiagnostic = options.recordDiagnostic;
	}

	begin(
		input: ActiveToolExecutionInput,
		emit: (event: RuntimeEvent) => void,
	): ActiveToolExecutionClaim {
		let activeForTurn = this.#activeByTurn.get(input.turnId);
		if (!activeForTurn) {
			activeForTurn = new Map();
			this.#activeByTurn.set(input.turnId, activeForTurn);
		}
		if (activeForTurn.has(input.callId)) {
			throw new Error("tool execution call id is already active");
		}
		const abortController = new AbortController();
		const claim: ActiveToolExecutionClaim = Object.freeze({
			turnId: input.turnId,
			trackingCallId: input.callId,
			callId: boundedCallId(input.callId),
			toolName: boundedToolName(input.toolName),
			...(input.terminalInteraction ? { terminalInteraction: input.terminalInteraction } : {}),
			signal: abortController.signal,
			startedAt: this.#clock(),
			interruptErrorKind: input.interruptErrorKind,
		});
		const record: ActiveToolExecutionRecord = {
			claim,
			abortController,
			terminalEmitted: false,
		};
		activeForTurn.set(input.callId, record);
		this.#records.set(claim, record);
		emit({
			type: "tool_execution_started",
			callId: claim.callId,
			toolName: claim.toolName,
			...(claim.terminalInteraction ? { terminalInteraction: claim.terminalInteraction } : {}),
		});
		return claim;
	}

	complete(
		claim: ActiveToolExecutionClaim,
		result: ToolExecutionResult,
		emit: (event: RuntimeEvent) => void,
	): boolean {
		const record = this.#claimRecord(claim);
		if (!record) return false;
		this.#forget(record);
		const durationMs = boundedDurationMs(claim.startedAt, this.#clock());
		publishRuntimeDiagnostic(this.#recordDiagnostic, {
			kind: "tool_execution",
			turnId: claim.turnId,
			callId: claim.callId,
			toolName: claim.toolName,
			durationMs,
			success: result.success,
			outputChars: result.modelOutput.length,
			outputTruncated: result.metadata.model_output_truncated === true,
			...(result.success || !result.errorKind
				? {}
				: { failureKind: result.errorKind.slice(0, 128) }),
		});
		emitToolExecutionResult(result, durationMs, emit);
		return true;
	}

	interrupt(
		claim: ActiveToolExecutionClaim,
		emit: (event: RuntimeEvent) => void,
	): boolean {
		const record = this.#claimRecord(claim);
		if (!record) return false;
		record.abortController.abort(new DOMException("tool interrupted", "AbortError"));
		return this.fail(claim, claim.interruptErrorKind, emit);
	}

	interruptTurn(turnId: string, emit: (event: RuntimeEvent) => void): number {
		const active = this.#activeByTurn.get(turnId);
		if (!active) return 0;
		let interrupted = 0;
		for (const record of [...active.values()]) {
			if (this.interrupt(record.claim, emit)) interrupted += 1;
		}
		return interrupted;
	}

	fail(
		claim: ActiveToolExecutionClaim,
		errorKind: string,
		emit: (event: RuntimeEvent) => void,
	): boolean {
		const record = this.#claimRecord(claim);
		if (!record) return false;
		this.#forget(record);
		const durationMs = boundedDurationMs(claim.startedAt, this.#clock());
		publishRuntimeDiagnostic(this.#recordDiagnostic, {
			kind: "tool_execution",
			turnId: claim.turnId,
			callId: claim.callId,
			toolName: claim.toolName,
			durationMs,
			success: false,
			outputChars: 0,
			outputTruncated: false,
			failureKind: errorKind.slice(0, 128),
		});
		emit({
			type: "tool_execution_failed",
			callId: claim.callId,
			toolName: claim.toolName,
			summary: errorKind === "effect_outcome_unknown"
				? `${claim.toolName} outcome is unknown after interruption`
				: errorKind === "tool_interrupted"
					? `${claim.toolName} interrupted`
					: `${claim.toolName} failed`,
			durationMs,
			errorKind,
			metadata: Object.freeze(claim.terminalInteraction ? { terminal_interaction: claim.terminalInteraction } : {}),
		});
		return true;
	}

	#claimRecord(claim: ActiveToolExecutionClaim): ActiveToolExecutionRecord | undefined {
		const record = this.#records.get(claim);
		if (!record || record.terminalEmitted) return undefined;
		if (this.#activeByTurn.get(claim.turnId)?.get(claim.trackingCallId) !== record) {
			return undefined;
		}
		return record;
	}

	#forget(record: ActiveToolExecutionRecord): void {
		record.terminalEmitted = true;
		const { claim } = record;
		const activeForTurn = this.#activeByTurn.get(claim.turnId);
		if (activeForTurn?.get(claim.trackingCallId) !== record) return;
		activeForTurn.delete(claim.trackingCallId);
		if (activeForTurn.size === 0) this.#activeByTurn.delete(claim.turnId);
	}
}

export function emitToolExecutionResult(
	result: ToolExecutionResult,
	durationMs: number,
	emit: (event: RuntimeEvent) => void,
): void {
	const shared = {
		callId: boundedCallId(result.callId),
		toolName: boundedToolName(result.toolName),
		summary: result.summary.slice(0, 512),
		durationMs,
		metadata: result.metadata,
	};
	if (result.success) {
		emit({ type: "tool_execution_completed", ...shared });
		return;
	}
	emit({
		type: "tool_execution_failed",
		...shared,
		...(result.errorKind ? { errorKind: result.errorKind.slice(0, 128) } : {}),
	});
}

export function boundedToolCallId(value: string): string {
	return boundedCallId(value);
}

export function boundedRuntimeToolName(value: string): string {
	return boundedToolName(value);
}

function boundedCallId(value: string): string {
	return value.slice(0, 256);
}

function boundedToolName(value: string): string {
	return value.slice(0, 128) || "Tool";
}

function boundedDurationMs(startedAt: number, finishedAt: number): number {
	const elapsed = finishedAt - startedAt;
	if (!Number.isFinite(elapsed)) return 0;
	return Math.min(86_400_000, Math.max(0, Math.round(elapsed)));
}
