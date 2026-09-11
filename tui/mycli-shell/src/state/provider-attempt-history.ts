import { parseGatewayResult, type GatewayParams, type GatewayResult } from "@mycli/contracts";
import { mergeProviderAttemptHistory } from "./provider-attempts.ts";
import type { RuntimeShellState } from "./runtime-state-model.ts";

interface AttemptHistoryOptions {
	readonly current: () => RuntimeShellState;
	readonly update: (state: RuntimeShellState) => void;
	readonly load: (params: GatewayParams<"provider.attempts.load">) => Promise<unknown>;
	readonly force?: boolean;
}

export async function loadEarlierProviderAttemptHistory(options: AttemptHistoryOptions): Promise<void> {
	const initial = options.current();
	if (!initial.sessionId) return;
	const oldestTranscript = initial.transcript.filter((item) => !item.providerAttempts?.length && item.created_at)
		.reduce((oldest, item) => Math.min(oldest, Date.parse(item.created_at!)), Infinity);
	// Bound each interaction; remaining pages stay explicitly available in the viewer.
	for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
		const current = options.current();
		const cursor = current.providerAttemptsNextBefore;
		if (!cursor || current.sessionId !== initial.sessionId || current.sessionGeneration !== initial.sessionGeneration) return;
		const oldestAttempt = current.transcript.flatMap((item) => item.providerAttempts ?? [])
			.reduce((oldest, record) => Math.min(oldest, Date.parse(record.observedAt)), Infinity);
		if (!(options.force && pageNumber === 0)
			&& (!Number.isFinite(oldestTranscript) || oldestAttempt <= oldestTranscript)) return;
		const page: GatewayResult<"provider.attempts.load"> = parseGatewayResult("provider.attempts.load", await options.load({
			session_id: initial.sessionId, before_event_id: cursor, limit: 200,
		}));
		const latest = options.current();
		if (latest.sessionId !== initial.sessionId || latest.sessionGeneration !== initial.sessionGeneration
			|| latest.providerAttemptsNextBefore !== cursor) return;
		if (page.session_id !== initial.sessionId) throw new Error("Retry history ownership mismatch.");
		const nextBefore = page.has_more ? page.next_before_event_id ?? page.records[0]?.eventId : null;
		if (page.has_more && (!nextBefore || nextBefore === cursor)) throw new Error("Retry history cursor did not advance.");
		options.update({ ...mergeProviderAttemptHistory(latest, page.records), providerAttemptsNextBefore: nextBefore ?? null });
	}
}
