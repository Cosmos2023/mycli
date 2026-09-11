import {
	AgentCapacityError,
	AgentDepthError,
	agentPathDepth,
	type AgentLifecycleStatus,
	type AgentPath,
} from "@mycli/core";

export interface AgentSchedulerCandidate {
	readonly threadId: string;
	readonly status: AgentLifecycleStatus;
	readonly lastActiveAt: string;
	readonly protected?: boolean;
}

export interface AgentSlotReservation {
	readonly threadId: string;
	readonly evictThreadId?: string;
}

export interface AgentSchedulerOptions {
	readonly maxResidents?: number;
	readonly maxDepth?: number;
}

const DEFAULT_MAX_RESIDENTS = 4;
const DEFAULT_MAX_DEPTH = 1;
const ROOT_SLOT = "\0root";

export class AgentScheduler {
	readonly #maxResidents: number;
	readonly #maxDepth: number;
	readonly #slots = new Set<string>([ROOT_SLOT]);

	constructor(options: AgentSchedulerOptions = {}) {
		this.#maxResidents = positiveLimit(
			options.maxResidents ?? DEFAULT_MAX_RESIDENTS,
			"maxResidents",
		);
		this.#maxDepth = nonNegativeLimit(options.maxDepth ?? DEFAULT_MAX_DEPTH, "maxDepth");
	}

	get maxResidents(): number {
		return this.#maxResidents;
	}

	get maxDepth(): number {
		return this.#maxDepth;
	}

	assertChildDepth(parentPath: AgentPath): void {
		if (agentPathDepth(parentPath) + 1 > this.#maxDepth) {
			throw new AgentDepthError(this.#maxDepth);
		}
	}

	reserve(
		threadId: string,
		candidates: readonly AgentSchedulerCandidate[] = [],
	): AgentSlotReservation {
		const normalized = requiredThreadId(threadId);
		if (this.#slots.has(normalized)) return Object.freeze({ threadId: normalized });
		if (this.#slots.size < this.#maxResidents) {
			this.#slots.add(normalized);
			return Object.freeze({ threadId: normalized });
		}
		const evict = candidates
			.filter((candidate) => candidate.status === "idle"
				&& candidate.protected !== true
				&& this.#slots.has(candidate.threadId))
			.sort(compareEvictionCandidate)[0];
		if (!evict) throw new AgentCapacityError(this.#maxResidents);
		this.#slots.delete(evict.threadId);
		this.#slots.add(normalized);
		return Object.freeze({ threadId: normalized, evictThreadId: evict.threadId });
	}

	release(threadId: string): boolean {
		return this.#slots.delete(requiredThreadId(threadId));
	}

	has(threadId: string): boolean {
		return this.#slots.has(requiredThreadId(threadId));
	}

	residentCount(): number {
		return this.#slots.size;
	}
}

function compareEvictionCandidate(
	left: AgentSchedulerCandidate,
	right: AgentSchedulerCandidate,
): number {
	return left.lastActiveAt.localeCompare(right.lastActiveAt)
		|| left.threadId.localeCompare(right.threadId);
}

function requiredThreadId(value: string): string {
	const normalized = value.trim();
	if (!normalized) throw new TypeError("agent scheduler thread id must be non-empty");
	return normalized;
}

function positiveLimit(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive integer`);
	}
	return value;
}

function nonNegativeLimit(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative integer`);
	}
	return value;
}
