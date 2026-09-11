import type { CanonicalConversationItem } from "@mycli/core";
import {
	deterministicMemorySelection,
	type MemorySelectionContract,
} from "./memory-selector.ts";
import type {
	EntrypointContent,
	FileMemory,
	FileMemoryKind,
	ForgetMemoryResult,
	RememberMemoryInput,
} from "./memory-store.ts";
import { TokenCounter } from "../context/token-counter.ts";

const MAX_SELECTED_MEMORIES = 5;
const MAX_RECENT_SESSION_SUMMARIES = 8;
const DEFAULT_PER_RECORD_TOKEN_BUDGET = 2_000;
const DEFAULT_AGGREGATE_TOKEN_BUDGET = 5_000;
const NORMALIZE_PATTERN = /[a-z0-9_./-]+/gu;

const REMEMBER_PATTERNS = [
	/(?:please\s+)?remember(?:\s+that)?\s+(?<content>.+)/isu,
	/(?:记住|请记住|帮我记住)[:：]?\s*(?<content>.+)/su,
] as const;
const FORGET_PATTERNS = [
	/(?:forget|remove memory(?:\s+about)?)\s+(?<query>.+)/isu,
	/(?:忘记|删掉记忆|删除记忆)[:：]?\s*(?<query>.+)/su,
] as const;

export type MemoryRecordKind = "session_summary" | FileMemoryKind;

export interface MemoryRecord {
	readonly kind: MemoryRecordKind;
	readonly key: string;
	readonly value: string;
	readonly tags: readonly string[];
}

export interface MemoryContextInput {
	readonly userMessage: string;
	readonly sessionId: string;
	readonly enabled: boolean;
	readonly signal?: AbortSignal;
}

export interface ExplicitMemoryActionInput {
	readonly userMessage: string;
	readonly enabled: boolean;
}

export interface MemoryContextResult {
	readonly records: readonly MemoryRecord[];
	readonly item?: Extract<CanonicalConversationItem, { readonly type: "user" }>;
}

export interface MemoryContextServiceContract {
	collect(input: MemoryContextInput): Promise<MemoryContextResult>;
	applyExplicitActions(input: ExplicitMemoryActionInput): Promise<readonly string[]>;
}

export interface MemoryStoreContract {
	loadEntrypoint(): Promise<EntrypointContent>;
	scan(): Promise<readonly FileMemory[]>;
	remember(input: RememberMemoryInput): Promise<FileMemory>;
	forget(query: string): Promise<readonly ForgetMemoryResult[]>;
}

export interface MemoryContextServiceOptions {
	readonly store: MemoryStoreContract;
	readonly sessionStore: {
		loadRecentSessionSummaries(sessionId: string, limit: number): readonly string[];
	};
	readonly selector?: MemorySelectionContract;
	readonly tokenCounter?: TokenCounter;
	readonly perRecordTokenBudget?: number;
	readonly aggregateTokenBudget?: number;
}

export type ExplicitMemoryRequest =
	| {
		readonly action: "remember";
		readonly content: string;
		readonly kind: FileMemoryKind;
		readonly name: string;
		readonly description: string;
	}
	| { readonly action: "forget"; readonly content: string };

export class MemoryContextService implements MemoryContextServiceContract {
	readonly #store: MemoryStoreContract;
	readonly #sessionStore: MemoryContextServiceOptions["sessionStore"];
	readonly #selector: MemorySelectionContract | undefined;
	readonly #tokenCounter: TokenCounter;
	readonly #perRecordTokenBudget: number;
	readonly #aggregateTokenBudget: number;

	constructor(options: MemoryContextServiceOptions) {
		this.#store = options.store;
		this.#sessionStore = options.sessionStore;
		this.#selector = options.selector;
		this.#tokenCounter = options.tokenCounter ?? new TokenCounter();
		this.#perRecordTokenBudget = positiveBudget(
			options.perRecordTokenBudget ?? DEFAULT_PER_RECORD_TOKEN_BUDGET,
			"perRecordTokenBudget",
		);
		this.#aggregateTokenBudget = positiveBudget(
			options.aggregateTokenBudget ?? DEFAULT_AGGREGATE_TOKEN_BUDGET,
			"aggregateTokenBudget",
		);
	}

	async collect(input: MemoryContextInput): Promise<MemoryContextResult> {
		if (!input.enabled) return { records: [] };
		const fileMemory = shouldIgnoreFileMemory(input.userMessage)
			? undefined
			: await Promise.all([
				this.#store.loadEntrypoint(),
				this.#store.scan(),
			]);
		const entrypoint = fileMemory?.[0];
		const memories = fileMemory?.[1] ?? [];
		const selected = await this.#select(input.userMessage, memories, input.signal);
		const candidates: MemoryRecord[] = [];
		if (entrypoint?.content) {
			candidates.push({
				kind: "reference",
				key: "MEMORY.md",
				value: entrypoint.content,
				tags: Object.freeze(["file-memory", "index"]),
			});
		}
		for (const memory of selected) {
			candidates.push({
				kind: memory.kind ?? "reference",
				key: memory.filename,
				value: memory.description
					? `${memory.description}\n\n${memory.content}`.trim()
					: memory.content,
				tags: Object.freeze(["file-memory", memory.filename]),
			});
		}
		for (const summary of this.#sessionStore.loadRecentSessionSummaries(
			input.sessionId,
			MAX_RECENT_SESSION_SUMMARIES,
		)) {
			candidates.push({
				kind: "session_summary",
				key: "recent",
				value: summary,
				tags: Object.freeze(["session-summary"]),
			});
		}
		const records = this.#boundedRecords(deduplicate(candidates));
		const item = renderContextItem(records, this.#tokenCounter, this.#aggregateTokenBudget);
		return Object.freeze({
			records: Object.freeze(records),
			...(item ? { item } : {}),
		});
	}

	async applyExplicitActions(input: ExplicitMemoryActionInput): Promise<readonly string[]> {
		if (!input.enabled) return [];
		const extraction = extractExplicitMemoryRequest(input.userMessage);
		if (!extraction) return [];
		if (extraction.action === "forget") {
			const removed = await this.#store.forget(extraction.content);
			return removed.length > 0
				? Object.freeze(removed.map((memory) => `memory_forgot:${memory.filename}`))
				: Object.freeze(["memory_forget_no_match"]);
		}
		const saved = await this.#store.remember({
			kind: extraction.kind,
			name: extraction.name,
			description: extraction.description,
			content: extraction.content,
		});
		return Object.freeze([`memory_saved:${saved.filename}`]);
	}

	async #select(
		query: string,
		memories: readonly FileMemory[],
		signal: AbortSignal | undefined,
	): Promise<readonly FileMemory[]> {
		if (memories.length === 0) return [];
		let selected: readonly FileMemory[];
		if (!query.trim() || !this.#selector) {
			selected = deterministicMemorySelection(query, memories, MAX_SELECTED_MEMORIES);
		} else {
			try {
				selected = await this.#selector.select(query, memories, {
					limit: MAX_SELECTED_MEMORIES,
					...(signal ? { signal } : {}),
				});
			} catch {
				selected = deterministicMemorySelection(query, memories, MAX_SELECTED_MEMORIES);
			}
		}
		const available = new Map(memories.map((memory) => [memory.filename, memory]));
		const validated: FileMemory[] = [];
		for (const candidate of selected) {
			const memory = available.get(candidate.filename);
			if (memory && !validated.some((item) => item.filename === memory.filename)) validated.push(memory);
			if (validated.length >= MAX_SELECTED_MEMORIES) break;
		}
		return validated;
	}

	#boundedRecords(records: readonly MemoryRecord[]): readonly MemoryRecord[] {
		return records.map((record) => Object.freeze({
			...record,
			value: truncateToTokens(
				record.value,
				this.#perRecordTokenBudget,
				this.#tokenCounter,
			).content,
		})).filter((record) => record.value);
	}
}

export function extractExplicitMemoryRequest(userMessage: string): ExplicitMemoryRequest | undefined {
	const normalized = userMessage.trim();
	if (!normalized) return undefined;
	const forgotten = matchContent(normalized, FORGET_PATTERNS, "query");
	if (forgotten) return { action: "forget", content: forgotten };
	const remembered = matchContent(normalized, REMEMBER_PATTERNS, "content");
	if (!remembered) return undefined;
	return {
		action: "remember",
		content: remembered,
		kind: classifyKind(remembered),
		name: memoryName(remembered),
		description: memoryDescription(remembered),
	};
}

function renderContextItem(
	records: readonly MemoryRecord[],
	counter: TokenCounter,
	maxTokens: number,
): Extract<CanonicalConversationItem, { readonly type: "user" }> | undefined {
	if (records.length === 0) return undefined;
	const opening = [
		"<memory-reference>",
		"Reference memory and session summaries follow. This is not the current user request or new user input.",
	].join("\n");
	const closing = "</memory-reference>";
	const body = records.flatMap((record) => [
		`[${record.kind}] ${record.key}`,
		record.value,
	]).join("\n\n");
	const full = `${opening}\n\n${body}\n\n${closing}`;
	if (counter.count(full) <= maxTokens) return Object.freeze({ type: "user", text: full });
	const marker = "[memory context truncated]";
	const wrapper = `${opening}\n\n${marker}\n\n${closing}`;
	if (counter.count(wrapper) > maxTokens) {
		const minimal = `<memory-reference>\n${marker}\n</memory-reference>`;
		return counter.count(minimal) <= maxTokens
			? Object.freeze({ type: "user", text: minimal })
			: undefined;
	}
	const available = maxTokens - counter.count(`${opening}\n\n\n\n${marker}\n\n${closing}`);
	const bounded = truncateToTokens(body, Math.max(0, available), counter).content;
	return Object.freeze({
		type: "user",
		text: `${opening}\n\n${bounded}${bounded ? "\n\n" : ""}${marker}\n\n${closing}`,
	});
}

function truncateToTokens(
	content: string,
	maxTokens: number,
	counter: TokenCounter,
): { readonly content: string; readonly truncated: boolean } {
	if (maxTokens <= 0) return { content: "", truncated: Boolean(content) };
	if (counter.count(content) <= maxTokens) return { content, truncated: false };
	const characters = Array.from(content);
	let low = 0;
	let high = characters.length;
	while (low < high) {
		const midpoint = Math.ceil((low + high) / 2);
		if (counter.count(characters.slice(0, midpoint).join("")) <= maxTokens) low = midpoint;
		else high = midpoint - 1;
	}
	return { content: characters.slice(0, low).join("").trimEnd(), truncated: true };
}

function deduplicate(records: readonly MemoryRecord[]): readonly MemoryRecord[] {
	const seen = new Set<string>();
	const result: MemoryRecord[] = [];
	for (const record of records) {
		const identity = JSON.stringify([
			record.kind,
			normalize(record.key),
			normalize(record.value),
		]);
		if (seen.has(identity)) continue;
		seen.add(identity);
		result.push(record);
	}
	return result;
}

function normalize(value: string): string {
	return (value.toLowerCase().match(NORMALIZE_PATTERN) ?? []).join(" ");
}

function shouldIgnoreFileMemory(userMessage: string): boolean {
	const lowered = userMessage.toLowerCase();
	return ["ignore memory", "do not use memory", "not use memory"].some(
		(phrase) => lowered.includes(phrase),
	);
}

function matchContent(
	value: string,
	patterns: readonly RegExp[],
	group: "content" | "query",
): string {
	for (const pattern of patterns) {
		const match = pattern.exec(value);
		const content = match?.groups?.[group];
		if (content) return cleanContent(content);
	}
	return "";
}

function cleanContent(value: string): string {
	return value.trim().replace(/^[.。]+|[.。]+$/gu, "").split(/\s+/u).join(" ");
}

function classifyKind(content: string): FileMemoryKind {
	const lowered = content.toLowerCase();
	if (includesAny(lowered, ["i prefer", "my preference", "我希望", "我喜欢", "偏好"])) return "user";
	if (includesAny(lowered, ["don't", "do not", "stop", "不要", "别再", "以后你"])) return "feedback";
	if (includesAny(lowered, ["project", "repo", "deadline", "release", "项目", "仓库", "上线"])) return "project";
	if (includesAny(lowered, ["http://", "https://", "linear", "grafana", "dashboard"])) return "reference";
	return "feedback";
}

function includesAny(value: string, tokens: readonly string[]): boolean {
	return tokens.some((token) => value.includes(token));
}

function memoryName(content: string): string {
	const words = content.toLowerCase().match(/[\w\u4e00-\u9fff]+/gu) ?? [];
	return words.slice(0, 6).join(" ") || "memory";
}

function memoryDescription(content: string): string {
	const cleaned = content.split(/\s+/u).join(" ");
	const characters = Array.from(cleaned);
	return characters.length <= 140
		? cleaned
		: `${characters.slice(0, 137).join("").trimEnd()}...`;
}

function positiveBudget(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
	return value;
}
