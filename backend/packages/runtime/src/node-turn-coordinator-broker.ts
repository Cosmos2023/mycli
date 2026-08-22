import { randomUUID } from "node:crypto";
import { modelInputSha256 } from "@mycli/core";
import type {
	AgentEffectLedgerStore,
	ModelInputLedgerStore,
} from "@mycli/storage";
import { StorageFailure } from "@mycli/storage";
import {
	commitRuntimeProviderStep,
} from "./model-input-pipeline.ts";
import type {
	CommittedRuntimeProviderStep,
	CommitRuntimeProviderStepInput,
} from "./model-input-pipeline.ts";
import type {
	AgentToolAttempt,
	AgentToolAttemptResult,
} from "./agent-loop-contracts.ts";

export interface NodeTurnCoordinatorBrokerOptions {
	readonly sessionId: string;
	readonly ledger: ModelInputLedgerStore;
	readonly effectLedger?: AgentEffectLedgerStore;
	readonly clock: () => string;
	readonly createId?: CommitRuntimeProviderStepInput["createId"];
}

export type CoordinatorProviderStepInput = Omit<
	CommitRuntimeProviderStepInput,
	"sessionId" | "ledger" | "clock" | "createId"
>;

export class NodeTurnCoordinatorBroker {
	readonly #options: NodeTurnCoordinatorBrokerOptions;

	constructor(options: NodeTurnCoordinatorBrokerOptions) {
		this.#options = options;
	}

	nextProviderStep(turnId: string): number {
		const latest = this.#options.ledger.loadLatestProviderRequestManifest(
			this.#options.sessionId,
		);
		if (!latest || latest.turnId !== turnId) return 1;
		if (!Number.isSafeInteger(latest.providerStep) || latest.providerStep >= Number.MAX_SAFE_INTEGER) {
			throw new StorageFailure("provider step sequence is exhausted");
		}
		return latest.providerStep + 1;
	}

	commitProviderStep(input: CoordinatorProviderStepInput): CommittedRuntimeProviderStep {
		const committed = commitRuntimeProviderStep({
			...input,
			sessionId: this.#options.sessionId,
			ledger: this.#options.ledger,
			clock: this.#options.clock,
			...(this.#options.createId ? { createId: this.#options.createId } : {}),
		});
		return committed;
	}

	recordProviderStep(
		requestId: string,
		state: "dispatch_started" | "acknowledged" | "failed" | "unknown",
		payload: Readonly<Record<string, string | number | boolean | null>>,
	): void {
		const existing = this.#options.ledger.loadProviderStepEvents(requestId).at(-1);
		if (existing?.state === state
			&& modelInputSha256(existing.payload) === modelInputSha256(payload)) {
			return;
		}
		this.#options.ledger.appendProviderStepEvent({
			eventId: this.#options.createId?.("lifecycle") ?? `lifecycle-${randomUUID()}`,
			requestId,
			sessionId: this.#options.sessionId,
			state,
			payload,
			createdAt: this.#options.clock(),
		});
	}

	async executeTool(
		input: AgentToolAttempt,
		execute: () => Promise<AgentToolAttemptResult["result"]>,
	): Promise<AgentToolAttemptResult> {
		const ledger = this.#options.effectLedger;
		if (!ledger) {
			return Object.freeze({
				attemptId: input.attemptId,
				position: input.base,
				result: await execute(),
			});
		}
		const reservation = ledger.reserve({
			attemptId: input.attemptId,
			kind: "tool",
			sessionId: this.#options.sessionId,
			turnId: input.turnId,
			jobId: input.jobId,
			externalId: input.call.callId,
			mutating: input.mutating,
			request: Object.freeze({
				tool_name: input.call.name,
				arguments_sha256: modelInputSha256(input.call.argumentsJson),
				mutating: input.mutating,
			}),
			createdAt: this.#options.clock(),
		});
		if (reservation.kind === "existing") {
			if (reservation.attempt.state === "completed" && reservation.attempt.result) {
				return Object.freeze({
					attemptId: input.attemptId,
					position: input.base,
					result: storedToolResult(reservation.attempt.result),
				});
			}
			throw new StorageFailure(`tool attempt is not replayable: ${reservation.attempt.state}`);
		}
		let result: AgentToolAttemptResult["result"];
		try {
			result = await execute();
		} catch (error) {
			const interrupted = error instanceof Error && error.name === "AbortError";
			const state = input.mutating
				? "effect_outcome_unknown"
				: interrupted ? "interrupted" : "failed";
			ledger.complete({
				attemptId: input.attemptId,
				state,
				result: Object.freeze({ error_kind: state }),
				completedAt: this.#options.clock(),
			});
			throw error;
		}
		ledger.complete({
			attemptId: input.attemptId,
			state: "completed",
			result: toolResultRecord(result),
			completedAt: this.#options.clock(),
		});
		return Object.freeze({ attemptId: input.attemptId, position: input.base, result });
	}
}

function toolResultRecord(
	result: AgentToolAttemptResult["result"],
): Readonly<Record<string, unknown>> {
	return Object.freeze({ ...result });
}

function storedToolResult(
	value: Readonly<Record<string, unknown>>,
): AgentToolAttemptResult["result"] {
	if (typeof value.callId !== "string" || !value.callId
		|| typeof value.toolName !== "string" || !value.toolName
		|| typeof value.success !== "boolean"
		|| typeof value.modelOutput !== "string"
		|| typeof value.summary !== "string"
		|| typeof value.metadata !== "object" || value.metadata === null
		|| Array.isArray(value.metadata)) {
		throw new StorageFailure("stored tool attempt result is invalid");
	}
	return Object.freeze({
		callId: value.callId,
		toolName: value.toolName,
		success: value.success,
		modelOutput: value.modelOutput,
		summary: value.summary,
		metadata: Object.freeze({ ...value.metadata as Readonly<Record<string, unknown>> }),
		...(typeof value.errorKind === "string" ? { errorKind: value.errorKind } : {}),
		...(isPlanUpdate(value.planUpdate) ? { planUpdate: value.planUpdate } : {}),
		...(isToolActivation(value.toolActivation) ? { toolActivation: value.toolActivation } : {}),
	});
}

function isPlanUpdate(value: unknown): value is NonNullable<AgentToolAttemptResult["result"]["planUpdate"]> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Readonly<Record<string, unknown>>;
	return Array.isArray(record.items);
}

function isToolActivation(
	value: unknown,
): value is NonNullable<AgentToolAttemptResult["result"]["toolActivation"]> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Array.isArray((value as Readonly<Record<string, unknown>>).names);
}
