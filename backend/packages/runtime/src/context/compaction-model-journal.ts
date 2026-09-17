import { parseProviderAttemptUpdate, parseRuntimeFailure, runtimeRetryStatusText, sanitizeRuntimeErrorDetail } from "@mycli/contracts";
import type { AppendCompactionActivityInput, TranscriptJsonValue } from "@mycli/storage";
import type { CompactionModelEvidence } from "./compaction-coordinator.ts";

interface CompactionModelJournalOptions {
	readonly sessionId: string;
	readonly store: { appendCompactionActivity(input: AppendCompactionActivityInput): boolean };
	readonly clock: () => string;
}

// Compaction owns a checkpoint, including manual commands that have no runtime_turns row.
export class CompactionModelJournal {
	#sequence = 0;
	constructor(readonly options: CompactionModelJournalOptions) {}

	record(input: CompactionModelEvidence): boolean {
		const event = input.event.type === "attempt"
			? { ...input.event, update: parseProviderAttemptUpdate(input.event.update) }
			: input.event.type === "failure" ? { ...input.event, failure: parseRuntimeFailure(input.event.failure) } : input.event;
		const failure = event.type === "failure" ? event.failure
			: event.type === "attempt" ? event.update.failure : undefined;
		const metadata: Record<string, TranscriptJsonValue> = {
			purpose: "compaction", operation_id: input.operationId, request_fingerprint: input.fingerprint,
			event_kind: "compaction_model", readable: event.type === "failure" || event.type === "recovery"
				|| (event.type === "attempt" && event.update.state === "scheduled"),
			...(failure ? { code: failure.code, message: failure.message,
				...(failure.errorContext ? { error_context: failure.errorContext } : {}),
				...(failure.additionalDetails ? { additional_details: failure.additionalDetails } : {}),
				...(failure.diagnostics ? { diagnostics: { ...failure.diagnostics } } : {}) } : {}),
		};
		if (event.type !== "failure" && event.request) {
			metadata.generation_request = { generation: event.request.generation,
				fingerprint: event.request.fingerprint,
				...(event.request.maxOutputTokens === undefined ? {} : { max_output_tokens: event.request.maxOutputTokens }),
				reasoning_effort: event.request.reasoningEffort };
		}
		let text: string;
		if (event.type === "attempt") {
			const update = event.update;
			metadata.operation_attempt = event.operationAttempt ?? update.attempt;
			metadata.provider = event.provider;
			metadata.model = event.model;
			const { failure: attemptFailure, ...fields } = update;
			metadata.provider_attempt = { ...fields, policy: { ...update.policy },
				...(attemptFailure ? { failure: { ...attemptFailure,
					...(attemptFailure.diagnostics ? { diagnostics: { ...attemptFailure.diagnostics } } : {}) } } : {}) };
			text = update.state === "scheduled"
				? `Context compression: ${runtimeRetryStatusText(update.failure!.code, update.attempt - 1,
					update.policy.requestMaxRetries + update.policy.streamMaxRetries)}`
				: `Context compression request ${update.state} (attempt ${update.attempt}).`;
		} else if (event.type === "usage") {
			metadata.provider = event.provider;
			metadata.model = event.model;
			metadata.attempt = event.attempt;
			metadata.usage = { ...event.usage };
			text = "Context compression usage recorded.";
		} else if (event.type === "recovery") {
			metadata.provider = event.provider;
			metadata.model = event.model;
			text = `Context compression: ${event.message}`;
		} else {
			metadata.usage = { ...event.usage };
			text = `Context compression failed: ${sanitizeRuntimeErrorDetail(failure?.message) ?? "Provider request failed."}`;
			const detail = sanitizeRuntimeErrorDetail(failure?.additionalDetails);
			if (detail) text += `\n${detail}`;
		}
		const sequence = this.#sequence + 1;
		const committed = this.options.store.appendCompactionActivity({
			checkpointId: input.operationId, fingerprint: input.fingerprint,
			activity: {
				sessionId: this.options.sessionId, turnId: input.turnId,
				eventId: `compaction-model:${input.operationId}:${sequence}`,
				activityType: event.type === "failure" ? "error" : "status",
				text, metadata, createdAt: this.options.clock(),
			},
		});
		if (committed) this.#sequence = sequence;
		return committed;
	}
}
