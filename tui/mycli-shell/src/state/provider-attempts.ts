import { parseProviderAttemptRecord, turnFailedNoticeId, turnInterruptedNoticeId, type ProviderAttemptRecord } from "@mycli/contracts";
import type { RuntimeShellState, RuntimeTranscriptItem } from "./runtime-state-model.ts";

export function mergeProviderAttemptHistory(
	state: RuntimeShellState,
	values: readonly unknown[],
	live = false,
): RuntimeShellState {
	let next = state;
	for (const value of values.slice(-500)) {
		let record: ProviderAttemptRecord;
		try { record = parseProviderAttemptRecord(value); } catch { continue; }
		if (record.sessionId !== state.sessionId) continue;
		if (live && (!state.turnRunning || record.turnId !== state.activeTurnId)) continue;
		const id = `provider-attempt:${record.requestId}`;
		const index = next.transcript.findIndex((item) => item.id === id);
		const previous = index < 0 ? undefined : next.transcript[index];
		const retained = previous?.providerAttempts ?? [];
		if (retained.some((candidate) => candidate.sequence === record.sequence)) continue;
		const records = [...retained, record].sort((left, right) => left.sequence - right.sequence).slice(-1000);
		const item: RuntimeTranscriptItem = {
			id, turn_id: record.turnId, type: "provider_attempt", text: "", folded: previous?.folded ?? true,
			created_at: records[0]!.observedAt, providerAttempts: records,
		};
		let transcript: RuntimeTranscriptItem[];
		if (index >= 0) {
			transcript = [...next.transcript.slice(0, index), item, ...next.transcript.slice(index + 1)];
		} else {
			const insertion = attemptInsertionIndex(next.transcript, item);
			transcript = [...next.transcript.slice(0, insertion), item, ...next.transcript.slice(insertion)];
		}
		next = { ...next, transcript };
		if (records.at(-1) !== record || !next.turnRunning || next.activeTurnId !== record.turnId) continue;
		if (record.state === "scheduled") {
			next = { ...next, liveStatus: {
				state: "running", kind: "reconnecting", text: `Retry attempt ${record.attempt}`,
				message: record.failure?.additionalDetails ?? record.failure?.message,
				retryAt: record.retryAt,
			} };
		} else if (record.state === "started" && record.attempt > 1) {
			next = { ...next, liveStatus: { state: "running", kind: "running", text: `Attempt ${record.attempt} started` } };
		} else if (["completed", "recovered", "exhausted", "cancelled", "unknown"].includes(record.state)) {
			next = { ...next, retryRestoreStatus: null,
				liveStatus: { state: "running", kind: "running", text: "Running" } };
		}
	}
	return live ? next : restoreAttemptPlacement(next);
}

function restoreAttemptPlacement(state: RuntimeShellState): RuntimeShellState {
	const attempts = state.transcript.filter((item) => item.providerAttempts?.length);
	if (attempts.length === 0) return state;
	const transcript = state.transcript.filter((item) => !item.providerAttempts?.length);
	for (const item of attempts.sort((left, right) => Date.parse(left.created_at!) - Date.parse(right.created_at!))) {
		transcript.splice(attemptInsertionIndex(transcript, item), 0, item);
	}
	return transcript.every((item, index) => state.transcript[index] === item) ? state : { ...state, transcript };
}

function attemptInsertionIndex(items: readonly RuntimeTranscriptItem[], attempt: RuntimeTranscriptItem): number {
	const turnId = attempt.providerAttempts?.[0]?.turnId;
	const interruptedId = turnId ? turnInterruptedNoticeId(turnId) : undefined;
	const failedId = turnId ? turnFailedNoticeId(turnId) : undefined;
	const observedAt = Date.parse(attempt.created_at ?? "");
	const owned = items.flatMap((item, index) => {
		const owner = item.turn_id ?? item.metadata?.interrupted_turn_id;
		return !item.providerAttempts && turnId && owner === turnId ? [index] : [];
	});
	let start = owned[0] ?? 0;
	let end = owned.at(-1) === undefined ? items.length : owned.at(-1)! + 1;
	if (owned.length > 0) {
		if (items[start]?.type === "user") start += 1;
	} else {
		// Legacy pages lack ownership. User boundaries still outrank delayed notice timestamps.
		let user = items.findLastIndex((item) => item.type === "user"
			&& Date.parse(item.created_at ?? "") <= observedAt);
		if (user < 0) user = items.findLastIndex((item) => item.type === "user" && !item.created_at);
		start = user + 1;
		const nextUser = items.findIndex((item, index) => index >= start && item.type === "user");
		if (nextUser >= 0) end = nextUser;
	}
	for (let index = start; index < end; index++) {
		const item = items[index]!;
		if (owned.length > 0 && item.turn_id && item.turn_id !== turnId) continue;
		if (Date.parse(item.created_at ?? "") > observedAt
			|| item.type === "turn_completed" || item.metadata?.event_kind === "turn_interrupted"
			|| item.id === interruptedId || item.id === failedId) return index;
	}
	return end;
}

export function hasDurableAttemptForActiveTurn(state: RuntimeShellState): boolean {
	return state.activeTurnId !== null && state.transcript.some((item) =>
		item.providerAttempts?.some((record) => record.turnId === state.activeTurnId));
}
