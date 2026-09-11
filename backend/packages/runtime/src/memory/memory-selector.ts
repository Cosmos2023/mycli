import {
	projectProviderRequest,
} from "@mycli/core";
import type {
	ProviderRequestConfig,
} from "@mycli/core";
import type { ModelProvider } from "@mycli/providers";
import { compareUnicodeCodePoints } from "./memory-ordering.ts";
import type { FileMemory } from "./memory-store.ts";

const MAX_SELECTED_MEMORIES = 5;
const SELECTOR_MAX_OUTPUT_TOKENS = 512;
const TOKEN_PATTERN = /[a-z0-9_./-]+/gu;

const SELECTOR_INSTRUCTIONS = [
	"You select memory files that are clearly useful for the current user query.",
	"Return JSON only, with exactly this shape: {\"selected_memories\":[\"filename.md\"]}.",
	"Select at most five filenames from the supplied list. Do not invent filenames or paths.",
	"Return an empty selected_memories array when no listed memory is clearly useful.",
].join("\n");

export interface MemorySelectionOptions {
	readonly limit?: number;
	readonly signal?: AbortSignal;
}

export interface MemorySelectorOptions {
	readonly provider: ModelProvider;
	readonly providerConfig: Pick<ProviderRequestConfig, "provider" | "protocol" | "model" | "nativeTransport">;
	readonly maxOutputTokens?: number;
}

export interface MemorySelectionContract {
	select(
		query: string,
		memories: readonly FileMemory[],
		options?: MemorySelectionOptions,
	): Promise<readonly FileMemory[]>;
}

export class MemorySelector implements MemorySelectionContract {
	readonly #provider: ModelProvider;
	readonly #providerConfig: Pick<ProviderRequestConfig, "provider" | "protocol" | "model" | "nativeTransport">;
	readonly #maxOutputTokens: number;

	constructor(options: MemorySelectorOptions) {
		this.#provider = options.provider;
		this.#providerConfig = options.providerConfig;
		this.#maxOutputTokens = boundedOutputTokens(
			options.maxOutputTokens ?? SELECTOR_MAX_OUTPUT_TOKENS,
		);
	}

	async select(
		query: string,
		memories: readonly FileMemory[],
		options: MemorySelectionOptions = {},
	): Promise<readonly FileMemory[]> {
		const limit = boundedLimit(options.limit ?? MAX_SELECTED_MEMORIES);
		if (limit === 0 || memories.length === 0) return [];
		const normalizedQuery = query.trim();
		if (!normalizedQuery) {
			return deterministicMemorySelection(normalizedQuery, memories, limit);
		}

		try {
			const selected = await this.#modelSelection(
				normalizedQuery,
				memories,
				limit,
				options.signal,
			);
			if (selected.length > 0) return selected;
		} catch {
			// Model selection is optional; deterministic matching is the safe fallback.
		}
		return deterministicMemorySelection(normalizedQuery, memories, limit);
	}

	async #modelSelection(
		query: string,
		memories: readonly FileMemory[],
		limit: number,
		signal: AbortSignal | undefined,
	): Promise<readonly FileMemory[]> {
		const byFilename = new Map(memories.map((memory) => [memory.filename, memory]));
		const userText = [
			`User query:\n${query}`,
			"Available memory files:",
			formatManifest(memories),
			`Select up to ${limit} memory files. Return JSON only.`,
		].join("\n\n");
		const request = projectProviderRequest({
			config: {
				...this.#providerConfig,
				reasoningEffort: "none",
				maxOutputTokens: this.#maxOutputTokens,
			},
			instructions: SELECTOR_INSTRUCTIONS,
			history: Object.freeze([{ type: "user", text: userText }]),
			tools: Object.freeze([]),
		});
		let text = "";
		let completed = false;
		for await (const event of this.#provider.stream(request, {
			signal: signal ?? new AbortController().signal,
		})) {
			if (completed) return [];
			switch (event.type) {
				case "text_delta":
					text += event.text;
					break;
				case "completed":
					completed = true;
					break;
				case "tool_call":
					return [];
				default:
					break;
			}
		}
		if (!completed || !text.trim()) return [];
		const filenames = selectedFilenames(text, new Set(byFilename.keys()), limit);
		return filenames.map((filename) => byFilename.get(filename)!);
	}
}

export function deterministicMemorySelection(
	query: string,
	memories: readonly FileMemory[],
	limit = MAX_SELECTED_MEMORIES,
): readonly FileMemory[] {
	const bounded = boundedLimit(limit);
	if (bounded === 0) return [];
	const queryTokens = tokens(query);
	return memories
		.map((memory) => ({ memory, score: scoreMemory(queryTokens, memory) }))
		.filter((item) => item.score > 0)
		.sort((left, right) => (
			right.score - left.score
			|| right.memory.mtime - left.memory.mtime
			|| compareUnicodeCodePoints(left.memory.filename, right.memory.filename)
		))
		.slice(0, bounded)
		.map((item) => item.memory);
}

function scoreMemory(queryTokens: ReadonlySet<string>, memory: FileMemory): number {
	if (queryTokens.size === 0) {
		return memory.kind === "user" || memory.kind === "feedback" ? 0.1 : 0;
	}
	const filenameTokens = tokens(memory.filename);
	const nameTokens = tokens(memory.name);
	const descriptionTokens = tokens(memory.description);
	const contentTokens = tokens(memory.content);
	const weighted = 3 * matches(queryTokens, filenameTokens).size
		+ 3 * matches(queryTokens, nameTokens).size
		+ 2 * matches(queryTokens, descriptionTokens).size
		+ matches(queryTokens, contentTokens).size;
	const allTokens = new Set([
		...filenameTokens,
		...nameTokens,
		...descriptionTokens,
		...contentTokens,
	]);
	if (weighted === 0 || allTokens.size === 0) return 0;
	return weighted + matches(queryTokens, allTokens).size / Math.max(queryTokens.size, 1);
}

function matches(
	queryTokens: ReadonlySet<string>,
	fieldTokens: ReadonlySet<string>,
): ReadonlySet<string> {
	return new Set([...queryTokens].filter((queryToken) => [...fieldTokens].some(
		(fieldToken) => queryToken === fieldToken
			|| fieldToken.includes(queryToken)
			|| queryToken.includes(fieldToken),
	)));
}

function tokens(text: string): ReadonlySet<string> {
	return new Set(text.toLowerCase().match(TOKEN_PATTERN) ?? []);
}

function selectedFilenames(
	text: string,
	available: ReadonlySet<string>,
	limit: number,
): readonly string[] {
	let payload: unknown;
	try {
		payload = JSON.parse(text.trim());
	} catch {
		return [];
	}
	if (!isRecord(payload) || !Array.isArray(payload.selected_memories)) return [];
	const selected: string[] = [];
	for (const candidate of payload.selected_memories) {
		if (typeof candidate !== "string") continue;
		const filename = candidate.trim();
		if (available.has(filename) && !selected.includes(filename)) selected.push(filename);
		if (selected.length >= limit) break;
	}
	return selected;
}

function formatManifest(memories: readonly FileMemory[]): string {
	return memories.map((memory) => {
		const kind = memory.kind ? `[${memory.kind}] ` : "";
		const description = memory.description ? `: ${memory.description}` : "";
		return `- ${kind}${memory.filename} (${new Date(memory.mtime).toISOString()})${description}`;
	}).join("\n");
}

function boundedLimit(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(MAX_SELECTED_MEMORIES, Math.trunc(value)));
}

function boundedOutputTokens(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError("maxOutputTokens must be a positive safe integer");
	}
	return Math.min(value, SELECTOR_MAX_OUTPUT_TOKENS);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
