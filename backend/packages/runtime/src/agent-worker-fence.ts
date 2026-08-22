import type {
	AgentWorkerMessage,
} from "./agent-worker-protocol.ts";
import {
	parseAgentWorkerMessage,
} from "./agent-worker-protocol.ts";

export interface ActiveAgentWorkerFence {
	readonly coordinatorEpoch: string;
	readonly workerId: string;
	readonly workerGeneration: number;
	readonly leaseId: string;
	readonly jobId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly timelineWindowId: string;
	readonly timelineVersion: number;
	readonly nextSequence: number;
	readonly logicalInputSha256?: string;
}

export class AgentWorkerFenceError extends Error {
	readonly code = "agent_worker_fence_error" as const;

	constructor(message: string) {
		super(`agent_worker_fence_error: ${message}`);
		this.name = "AgentWorkerFenceError";
	}
}

export class AgentWorkerFence {
	#active: ActiveAgentWorkerFence;

	constructor(active: ActiveAgentWorkerFence) {
		this.#active = validateActiveFence(active);
	}

	snapshot(): ActiveAgentWorkerFence {
		return Object.freeze({ ...this.#active });
	}

	accept(value: unknown): AgentWorkerMessage {
		const message = parseAgentWorkerMessage(value);
		this.#validateIdentity(message);
		if (message.timelineWindowId !== this.#active.timelineWindowId
			|| message.timelineVersion !== this.#active.timelineVersion) {
			throw invalid("timeline position is stale");
		}
		if (message.sequence !== this.#active.nextSequence) {
			throw invalid("message sequence is not the next expected value");
		}
		if (message.payload.kind === "provider_step"
			&& this.#active.logicalInputSha256 !== undefined
			&& message.payload.logicalInputSha256 !== this.#active.logicalInputSha256) {
			throw invalid("logical input hash does not match the active timeline");
		}
		this.#active = Object.freeze({
			...this.#active,
			nextSequence: this.#active.nextSequence + 1,
		});
		return message;
	}

	acceptEffect<Result>(value: unknown, effect: (message: AgentWorkerMessage) => Result): Result {
		const message = this.accept(value);
		return effect(message);
	}

	advanceTimeline(input: {
		readonly baseVersion: number;
		readonly nextVersion: number;
		readonly logicalInputSha256?: string;
	}): void {
		if (input.baseVersion !== this.#active.timelineVersion
			|| input.nextVersion !== input.baseVersion + 1) {
			throw invalid("timeline advance is not contiguous");
		}
		this.#active = Object.freeze({
			...this.#active,
			timelineVersion: input.nextVersion,
			...(input.logicalInputSha256 === undefined
				? {}
				: { logicalInputSha256: input.logicalInputSha256 }),
		});
	}

	replaceTimeline(input: {
		readonly windowId: string;
		readonly version: number;
		readonly logicalInputSha256?: string;
	}): void {
		if (!input.windowId || input.windowId === this.#active.timelineWindowId) {
			throw invalid("replacement timeline window must be distinct");
		}
		if (!Number.isSafeInteger(input.version) || input.version < 0) {
			throw invalid("replacement timeline version is invalid");
		}
		this.#active = Object.freeze({
			...this.#active,
			timelineWindowId: input.windowId,
			timelineVersion: input.version,
			...(input.logicalInputSha256 === undefined
				? { logicalInputSha256: undefined }
				: { logicalInputSha256: input.logicalInputSha256 }),
		});
	}

	#validateIdentity(message: AgentWorkerMessage): void {
		const active = this.#active;
		if (message.coordinatorEpoch !== active.coordinatorEpoch) throw invalid("coordinator epoch is stale");
		if (message.workerId !== active.workerId) throw invalid("worker identity is stale");
		if (message.workerGeneration !== active.workerGeneration) throw invalid("worker generation is stale");
		if (message.leaseId !== active.leaseId) throw invalid("lease identity is stale");
		if (message.jobId !== active.jobId) throw invalid("job identity is stale");
		if (message.sessionId !== active.sessionId) throw invalid("session identity does not match");
		if (message.turnId !== active.turnId) throw invalid("turn identity does not match");
	}
}

function validateActiveFence(value: ActiveAgentWorkerFence): ActiveAgentWorkerFence {
	if (!Number.isSafeInteger(value.workerGeneration) || value.workerGeneration < 1) {
		throw invalid("worker generation is invalid");
	}
	if (!Number.isSafeInteger(value.timelineVersion) || value.timelineVersion < 0) {
		throw invalid("timeline version is invalid");
	}
	if (!Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1) {
		throw invalid("message sequence origin is invalid");
	}
	return Object.freeze({ ...value });
}

function invalid(message: string): AgentWorkerFenceError {
	return new AgentWorkerFenceError(message);
}
