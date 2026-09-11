import { stableModelInputJson } from "@mycli/core";
import { TOOL_SEARCH_TOOL_DEFINITION } from "./manifest.ts";
import { deepFreezeCopy } from "./manifest-helpers.ts";
import type {
	DeferredToolCandidate,
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
	ToolTurnCatalog,
} from "../types.ts";

const DEFAULT_RESULT_LIMIT = 8;
const MAX_RESULT_LIMIT = 16;
const MAX_DESCRIPTION_CHARS = 512;

interface IndexedCandidate extends DeferredToolCandidate {
	readonly normalizedName: string;
	readonly normalizedDescription: string;
	readonly normalizedOrigin: string;
}

export class ToolSearchTool implements ToolAdapter {
	readonly definition = TOOL_SEARCH_TOOL_DEFINITION;
	readonly supportsParallelToolCalls = true;
	#candidates: readonly IndexedCandidate[];
	readonly #turnCandidates = new Map<string, readonly IndexedCandidate[]>();

	constructor(candidates: readonly DeferredToolCandidate[]) {
		this.#candidates = Object.freeze(candidates.map(indexCandidate));
	}

	beginTurn(turnId: string, catalog?: ToolTurnCatalog): void {
		if (this.#turnCandidates.has(turnId)) return;
		if (!catalog) {
			this.#turnCandidates.set(turnId, this.#candidates);
			return;
		}
		const expected = new Map(catalog.deferredTools.map((definition) => [
			definition.name,
			stableModelInputJson(definition),
		]));
		this.#turnCandidates.set(turnId, Object.freeze(this.#candidates.filter((candidate) => (
			expected.get(candidate.definition.name) === stableModelInputJson(candidate.definition)
		))));
	}

	finishTurn(turnId: string): void {
		this.#turnCandidates.delete(turnId);
	}

	replaceCandidates(candidates: readonly DeferredToolCandidate[]): void {
		this.#candidates = Object.freeze(candidates.map(indexCandidate));
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options?: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		const query = normalizedQuery(argumentsValue.query);
		const limit = resultLimit(argumentsValue.limit);
		if (!query || limit === undefined) {
			return failure("Query must be non-empty and limit must be an integer from 1 through 16.");
		}
		const queryTokens = tokenize(query);
		const candidates = options?.ownerTurnId
			? this.#turnCandidates.get(options.ownerTurnId) ?? this.#candidates
			: this.#candidates;
		const matches = candidates
			.map((candidate) => ({ candidate, score: scoreCandidate(candidate, query, queryTokens) }))
			.filter((match) => match.score > 0)
			.sort((left, right) => right.score - left.score
				|| left.candidate.definition.name.localeCompare(right.candidate.definition.name, "en")
				|| left.candidate.definition.id.localeCompare(right.candidate.definition.id, "en"))
			.slice(0, limit);
		const tools = matches.map(({ candidate }) => Object.freeze({
			name: candidate.definition.name,
			source: candidate.source,
			description: candidate.definition.description.slice(0, MAX_DESCRIPTION_CHARS),
			origin: candidate.originMetadata,
		}));
		const names = Object.freeze(tools.map((tool) => tool.name));
		return {
			success: true,
			modelOutput: JSON.stringify({ tools }, null, 2),
			summary: names.length === 0
				? "No deferred tools matched"
				: `Activated ${names.length} deferred tool${names.length === 1 ? "" : "s"}`,
			metadata: Object.freeze({
				matched_count: names.length,
				catalog_count: candidates.length,
			}),
			toolActivation: Object.freeze({ names }),
		};
	}
}

function indexCandidate(candidate: DeferredToolCandidate): IndexedCandidate {
	return Object.freeze({
		definition: Object.freeze({
			...candidate.definition,
			inputSchema: deepFreezeCopy(candidate.definition.inputSchema),
		}),
		source: candidate.source,
		originMetadata: Object.freeze({ ...candidate.originMetadata }),
		...(candidate.sourceDescription === undefined ? {} : { sourceDescription: candidate.sourceDescription }),
		normalizedName: normalize(candidate.definition.name),
		normalizedDescription: normalize(candidate.definition.description),
		normalizedOrigin: normalize([
			candidate.source,
			candidate.sourceDescription ?? "",
			...Object.keys(candidate.originMetadata),
			...Object.values(candidate.originMetadata),
		].join(" ")),
	});
}

function scoreCandidate(
	candidate: IndexedCandidate,
	query: string,
	queryTokens: readonly string[],
): number {
	let score = 0;
	if (candidate.normalizedName === query) score += 1_000;
	else if (candidate.normalizedName.startsWith(query)) score += 700;
	else if (candidate.normalizedName.includes(query)) score += 500;
	if (candidate.normalizedDescription.includes(query)) score += 160;
	if (candidate.normalizedOrigin.includes(query)) score += 180;
	const nameTokens = tokenize(candidate.normalizedName);
	for (const token of queryTokens) {
		if (nameTokens.includes(token)) score += 140;
		else if (nameTokens.some((nameToken) => nameToken.startsWith(token))) score += 100;
		if (candidate.normalizedDescription.includes(token)) score += 25;
		if (candidate.normalizedOrigin.includes(token)) score += 35;
	}
	return score;
}

function normalizedQuery(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const query = normalize(value).trim();
	return query.length > 0 && query.length <= 512 ? query : undefined;
}

function resultLimit(value: unknown): number | undefined {
	if (value === undefined) return DEFAULT_RESULT_LIMIT;
	return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_RESULT_LIMIT
		? Number(value)
		: undefined;
}

function tokenize(value: string): readonly string[] {
	return Object.freeze(value.match(/[\p{L}\p{N}]+/gu) ?? []);
}

function normalize(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function failure(message: string): ToolAdapterResult {
	return {
		success: false,
		modelOutput: `tool_search failed\nError kind: invalid_arguments\nError: ${message}`,
		summary: "tool_search failed",
		errorKind: "invalid_arguments",
		metadata: Object.freeze({}),
	};
}
