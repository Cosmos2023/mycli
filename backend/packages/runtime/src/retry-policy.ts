export interface RetryDecisionInput {
	readonly retryable: boolean;
	readonly eventsObserved: number;
	readonly retriesUsed: number;
	readonly maxRetries: number;
	readonly retryAfterSeconds?: number;
	readonly random: () => number;
}

export type RetryDecision =
	| { readonly shouldRetry: false }
	| { readonly shouldRetry: true; readonly attempt: number; readonly delayMs: number };

export function decideRetry(input: RetryDecisionInput): RetryDecision {
	const retryLimit = clampInteger(input.maxRetries, 0, 100);
	if (!input.retryable || input.eventsObserved > 0 || input.retriesUsed >= retryLimit) {
		return { shouldRetry: false };
	}
	const attempt = input.retriesUsed + 1;
	const retryAfterMs = input.retryAfterSeconds === undefined
		? undefined
		: Math.max(0, input.retryAfterSeconds * 1000);
	const baseDelayMs = Math.min(4000, 200 * (2 ** (attempt - 1)));
	const random = Math.max(0, Math.min(1, input.random()));
	const jitterFactor = 0.9 + (random * 0.2);
	return {
		shouldRetry: true,
		attempt,
		delayMs: Math.round(retryAfterMs ?? baseDelayMs * jitterFactor),
	};
}

export async function sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		throw interruptedError();
	}
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, Math.max(0, delayMs));
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(interruptedError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function clampInteger(value: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) {
		return minimum;
	}
	return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function interruptedError(): Error {
	const error = new Error("interrupted: retry delay aborted");
	error.name = "AbortError";
	return error;
}
