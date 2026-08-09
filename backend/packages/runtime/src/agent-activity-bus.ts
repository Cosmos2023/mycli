import { agentThreadId } from "@mycli/core";
import type { AgentThreadId } from "@mycli/core";

export type AgentActivityEventKind = "mailbox" | "lifecycle" | "completion";

export interface AgentActivityEvent {
	readonly kind: AgentActivityEventKind;
	readonly rootThreadId: AgentThreadId;
	readonly threadId: AgentThreadId;
	readonly occurredAt: string;
}

export interface AgentActivityWaitInput {
	readonly rootThreadId: string;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
}

export type AgentActivityWaitResult =
	| { readonly kind: "activity"; readonly event: AgentActivityEvent }
	| { readonly kind: "timeout" };

type AgentActivityListener = (event: AgentActivityEvent) => void;

export class AgentActivityBus {
	readonly #listeners = new Set<AgentActivityListener>();

	publish(input: AgentActivityEvent): void {
		const event = Object.freeze({
			kind: input.kind,
			rootThreadId: agentThreadId(input.rootThreadId),
			threadId: agentThreadId(input.threadId),
			occurredAt: timestamp(input.occurredAt),
		});
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// Activity observers cannot affect lifecycle or mailbox commits.
			}
		}
	}

	wait(input: AgentActivityWaitInput): Promise<AgentActivityWaitResult> {
		const rootThreadId = agentThreadId(input.rootThreadId);
		if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
			throw new RangeError("timeoutMs must be a positive safe integer");
		}
		if (input.signal.aborted) return Promise.reject(abortError());
		return new Promise<AgentActivityWaitResult>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(
				() => finish(Object.freeze({ kind: "timeout" })),
				input.timeoutMs,
			);
			const cleanup = (): void => {
				clearTimeout(timer);
				this.#listeners.delete(onActivity);
				input.signal.removeEventListener("abort", onAbort);
			};
			const finish = (result: AgentActivityWaitResult): void => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			};
			const onActivity = (event: AgentActivityEvent): void => {
				if (event.rootThreadId === rootThreadId) {
					finish(Object.freeze({ kind: "activity", event }));
				}
			};
			const onAbort = (): void => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(abortError());
			};
			this.#listeners.add(onActivity);
			input.signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}

function timestamp(value: string): string {
	if (!value || value.length > 128 || Number.isNaN(Date.parse(value))) {
		throw new TypeError("occurredAt must be a valid timestamp");
	}
	return value;
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}
