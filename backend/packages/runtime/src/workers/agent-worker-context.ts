import { modelInputSha256, stableModelInputJson } from "@mycli/core";
import type {
	CanonicalConversationItem,
	InstructionSnapshot,
	ToolSetSnapshot,
} from "@mycli/core";
import type {
	AgentContextBootstrap,
	AgentContextDelta,
	AgentTimelinePosition,
} from "../agents/agent-loop-contracts.ts";

export interface ImmutableAgentSnapshotCacheOptions {
	readonly maxEntries?: number;
	readonly maxBytes?: number;
}

export interface ImmutableAgentSnapshotCacheStats {
	readonly entries: number;
	readonly bytes: number;
	readonly maxEntries: number;
	readonly maxBytes: number;
}

export class AgentWorkerContextError extends Error {
	readonly code = "agent_worker_context_error" as const;

	constructor(message: string) {
		super(`agent_worker_context_error: ${message}`);
		this.name = "AgentWorkerContextError";
	}
}

interface CacheEntry {
	readonly value: unknown;
	readonly bytes: number;
}

export const AGENT_WORKER_SNAPSHOT_CACHE_MAX_ENTRIES = 8;
export const AGENT_WORKER_SNAPSHOT_CACHE_MAX_BYTES = 512 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class ImmutableAgentSnapshotCache {
	readonly #maxEntries: number;
	readonly #maxBytes: number;
	readonly #entries = new Map<string, CacheEntry>();
	#bytes = 0;

	constructor(options: ImmutableAgentSnapshotCacheOptions = {}) {
		this.#maxEntries = positiveInteger(
			options.maxEntries ?? AGENT_WORKER_SNAPSHOT_CACHE_MAX_ENTRIES,
			"snapshot cache entries",
		);
		this.#maxBytes = positiveInteger(
			options.maxBytes ?? AGENT_WORKER_SNAPSHOT_CACHE_MAX_BYTES,
			"snapshot cache bytes",
		);
	}

	put(hash: string, value: unknown, pinned: ReadonlySet<string> = new Set()): unknown {
		assertSha256(hash, "snapshot hash");
		const normalized = immutableJsonValue(value);
		if (modelInputSha256(normalized) !== hash) {
			throw invalid("snapshot content hash does not match");
		}
		const json = stableModelInputJson(normalized);
		const bytes = Buffer.byteLength(json, "utf8");
		if (bytes > this.#maxBytes) throw invalid("snapshot exceeds cache byte limit");
		const existing = this.#entries.get(hash);
		if (existing) {
			this.#entries.delete(hash);
			this.#entries.set(hash, existing);
			return existing.value;
		}
		this.#evictFor(bytes, new Set([...pinned, hash]));
		if (this.#entries.size >= this.#maxEntries || this.#bytes + bytes > this.#maxBytes) {
			throw invalid("snapshot cache capacity is exhausted by pinned entries");
		}
		this.#entries.set(hash, Object.freeze({ value: normalized, bytes }));
		this.#bytes += bytes;
		return normalized;
	}

	get(hash: string): unknown | undefined {
		assertSha256(hash, "snapshot hash");
		const entry = this.#entries.get(hash);
		if (!entry) return undefined;
		if (modelInputSha256(entry.value) !== hash) {
			this.#entries.delete(hash);
			this.#bytes -= entry.bytes;
			throw invalid("cached snapshot content hash does not match");
		}
		this.#entries.delete(hash);
		this.#entries.set(hash, entry);
		return entry.value;
	}

	stats(): ImmutableAgentSnapshotCacheStats {
		return Object.freeze({
			entries: this.#entries.size,
			bytes: this.#bytes,
			maxEntries: this.#maxEntries,
			maxBytes: this.#maxBytes,
		});
	}

	#evictFor(incomingBytes: number, pinned: ReadonlySet<string>): void {
		for (const [hash, entry] of this.#entries) {
			if (this.#entries.size < this.#maxEntries && this.#bytes + incomingBytes <= this.#maxBytes) {
				return;
			}
			if (pinned.has(hash)) continue;
			this.#entries.delete(hash);
			this.#bytes -= entry.bytes;
		}
	}
}

export interface AgentWorkerJobSecrets {
	readonly providerApiKey?: string;
	readonly providerAuthToken?: string;
}

export interface AgentWorkerContextSnapshot {
	readonly jobId: string;
	readonly position: AgentTimelinePosition;
	readonly instructionSnapshot: InstructionSnapshot;
	readonly toolSetSnapshot: ToolSetSnapshot;
	readonly conversation: readonly CanonicalConversationItem[];
	readonly logicalInputSha256: string;
}

interface ActiveContext extends AgentWorkerContextSnapshot {
	readonly secrets?: AgentWorkerJobSecrets;
}

export class AgentWorkerContextState {
	readonly #cache: ImmutableAgentSnapshotCache;
	#active: ActiveContext | undefined;

	constructor(cache = new ImmutableAgentSnapshotCache()) {
		this.#cache = cache;
	}

	bootstrap(input: AgentContextBootstrap, secrets?: AgentWorkerJobSecrets): void {
		if (this.#active) throw invalid("job context is already bootstrapped");
		this.#active = this.#install(input, secrets, new Set());
	}

	applyDelta(input: AgentContextDelta): void {
		const active = this.#required();
		if (input.jobId !== active.jobId) throw invalid("context delta job does not match");
		assertSamePosition(input.base, active.position, "context delta base is stale");
		if (input.kind === "replace") {
			if (input.bootstrap.jobId !== active.jobId) {
				throw invalid("replacement bootstrap job does not match");
			}
			if (input.bootstrap.position.windowId === active.position.windowId) {
				throw invalid("replacement bootstrap must use a distinct window");
			}
			this.#active = this.#install(
				input.bootstrap,
				active.secrets,
				new Set(),
			);
			return;
		}
		if (input.next.windowId !== active.position.windowId
			|| input.next.version !== active.position.version + 1) {
			throw invalid("context delta is not contiguous");
		}
		assertSha256(input.logicalInputSha256, "context delta logical input hash");
		this.#active = Object.freeze({
			...active,
			position: Object.freeze({ ...input.next }),
			conversation: Object.freeze([...active.conversation, ...immutableConversation(input.items)]),
			logicalInputSha256: input.logicalInputSha256,
		});
	}

	snapshot(): AgentWorkerContextSnapshot {
		const active = this.#required();
		return Object.freeze({
			jobId: active.jobId,
			position: active.position,
			instructionSnapshot: active.instructionSnapshot,
			toolSetSnapshot: active.toolSetSnapshot,
			conversation: active.conversation,
			logicalInputSha256: active.logicalInputSha256,
		});
	}

	hasSecrets(): boolean {
		return this.#active?.secrets !== undefined;
	}

	release(): void {
		this.#active = undefined;
	}

	cacheStats(): ImmutableAgentSnapshotCacheStats {
		return this.#cache.stats();
	}

	#install(
		input: AgentContextBootstrap,
		secrets: AgentWorkerJobSecrets | undefined,
		additionalPinned: ReadonlySet<string>,
	): ActiveContext {
		if (!input.jobId) throw invalid("context bootstrap job is invalid");
		assertPosition(input.position);
		assertSha256(input.logicalInputSha256, "context bootstrap logical input hash");
		const instructionHash = input.instructionSnapshot.contentSha256;
		const toolHash = input.toolSetSnapshot.contentSha256;
		const pinned = new Set([...additionalPinned, instructionHash, toolHash]);
		const instructionContent = this.#cache.put(
			instructionHash,
			input.instructionSnapshot.content,
			pinned,
		);
		const tools = this.#cache.put(toolHash, input.toolSetSnapshot.tools, pinned);
		return Object.freeze({
			jobId: input.jobId,
			position: Object.freeze({ ...input.position }),
			instructionSnapshot: Object.freeze({
				...input.instructionSnapshot,
				content: instructionContent as string,
			}),
			toolSetSnapshot: Object.freeze({
				...input.toolSetSnapshot,
				tools: tools as ToolSetSnapshot["tools"],
			}),
			conversation: immutableConversation(input.conversation),
			logicalInputSha256: input.logicalInputSha256,
			...(secrets ? { secrets: Object.freeze({ ...secrets }) } : {}),
		});
	}

	#required(): ActiveContext {
		if (!this.#active) throw invalid("job context is not bootstrapped");
		return this.#active;
	}
}

function immutableConversation(
	value: readonly CanonicalConversationItem[],
): readonly CanonicalConversationItem[] {
	return immutableJsonValue(value) as readonly CanonicalConversationItem[];
}

function immutableJsonValue(value: unknown): unknown {
	let json: string;
	try {
		json = stableModelInputJson(value);
	} catch {
		throw invalid("snapshot is not serializable");
	}
	if (json === undefined) throw invalid("snapshot is not serializable");
	return deepFreeze(JSON.parse(json) as unknown);
}

function deepFreeze(value: unknown): unknown {
	if (Array.isArray(value)) {
		for (const item of value) deepFreeze(item);
		return Object.freeze(value);
	}
	if (typeof value === "object" && value !== null) {
		for (const item of Object.values(value)) deepFreeze(item);
		return Object.freeze(value);
	}
	return value;
}

function assertSamePosition(
	value: AgentTimelinePosition,
	expected: AgentTimelinePosition,
	message: string,
): void {
	if (value.windowId !== expected.windowId || value.version !== expected.version) {
		throw invalid(message);
	}
}

function assertPosition(value: AgentTimelinePosition): void {
	if (!value.windowId || !Number.isSafeInteger(value.version) || value.version < 0) {
		throw invalid("context timeline position is invalid");
	}
}

function assertSha256(value: string, label: string): void {
	if (!SHA256_PATTERN.test(value)) throw invalid(`${label} is invalid`);
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be positive`);
	return value;
}

function invalid(message: string): AgentWorkerContextError {
	return new AgentWorkerContextError(message);
}
