import { generationValue, stringValue } from "../state/payload-values.ts";
import type { RuntimeShellState } from "../state/runtime-state-model.ts";
import { sessionChangeCanApply } from "../state/session-ownership.ts";
import { runtimeStateAfterSessionResume } from "../state/session-state.ts";
import { runtimeStateFromOlderTranscriptPage } from "../state/transcript-history.ts";

export interface SessionMutationContext {
	readonly sessionId: string | null;
	readonly generation: number | null;
}

interface SessionTransitionOptions {
	readonly current: () => RuntimeShellState;
	readonly update: (state: RuntimeShellState, replaceTranscript: boolean) => void;
	readonly loadTranscript: (sessionId: string) => Promise<Record<string, unknown>>;
}

/** Owns asynchronous history loads for both inline commands and the session picker. */
export class SessionTransitionController {
	private revision = 0;

	constructor(private readonly options: SessionTransitionOptions) {}

	invalidate(): void {
		this.revision += 1;
	}

	async resume(
		result: Record<string, unknown>,
		title?: string,
		source?: SessionMutationContext,
	): Promise<boolean> {
		const sessionId = stringValue(result.session_id);
		if (!sessionId) throw new Error("Gateway returned a session transition without a session ID.");
		const current = this.options.current();
		const generation = generationValue(result.generation);
		if (!sessionChangeCanApply(current, sessionId, generation)) return false;
		if (generation === null && source
			&& current.sessionId !== sessionId
			&& (current.sessionId !== source.sessionId || current.sessionGeneration !== source.generation)) return false;

		const revision = ++this.revision;
		const resumed = runtimeStateAfterSessionResume(current, sessionId, title ?? sessionId, result);
		this.options.update(resumed, true);
		const isCurrent = (): boolean => {
			const latest = this.options.current();
			return this.revision === revision && latest.sessionId === sessionId
				&& latest.sessionGeneration === resumed.sessionGeneration;
		};
		let transcript: Record<string, unknown>;
		try {
			transcript = await this.options.loadTranscript(sessionId);
		} catch (error) {
			if (!isCurrent()) return false;
			throw error;
		}
		if (!isCurrent()) return false;
		if (stringValue(transcript.session_id) !== sessionId) {
			throw new Error("Gateway returned history for a different session.");
		}
		this.options.update(runtimeStateFromOlderTranscriptPage(this.options.current(), transcript), false);
		return true;
	}
}
