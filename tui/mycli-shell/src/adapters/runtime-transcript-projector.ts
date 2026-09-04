import type {
	MycliShellBash,
	MycliShellMessage,
	MycliShellSession,
	MycliShellState,
	MycliShellTool,
	MycliShellTranscriptBlock,
	MycliShellVisualSettings,
} from "../model.ts";
import type { RuntimeShellState, RuntimeTranscriptItem } from "./runtime-state-model.ts";

export type RuntimeTranscriptProjection = {
	messages: MycliShellMessage[];
	tools: MycliShellTool[];
	bash: MycliShellBash[];
	transcript: MycliShellTranscriptBlock[];
};

export type RuntimeTranscriptUpdateKind = "unchanged" | "tail" | "replace";

export type RuntimeShellStatePresenter = (
	state: RuntimeShellState,
	sessions?: MycliShellSession[],
	projectedTranscript?: RuntimeTranscriptProjection,
	sourceStart?: number,
) => MycliShellState;

type RuntimeProjectionCounts = {
	messages: number;
	tools: number;
	bash: number;
	transcript: number;
};

type RuntimeTranscriptProjectionCache = {
	projection: RuntimeTranscriptProjection;
	sourceTranscript: RuntimeTranscriptItem[];
	sourceLength: number;
	penultimateSourceItem?: RuntimeTranscriptItem;
	lastSourceItem?: RuntimeTranscriptItem;
	lastSourcePrefix: RuntimeProjectionCounts;
	activeAssistantItemId: string | null;
	activeAssistantSourceIndex: number | null;
	activeAssistantPrefix: RuntimeProjectionCounts | null;
	liveReasoningText?: string;
	liveReasoningKind?: string;
	workspace: string;
	turnRunning: boolean;
	toolDetailsDefault: MycliShellVisualSettings["toolDetailsDefault"];
};

/** Owns incremental transcript projection; runtime event reduction remains independent. */
export class RuntimeTranscriptProjector {
	private cache: RuntimeTranscriptProjectionCache | null = null;

	constructor(private readonly presentState: RuntimeShellStatePresenter) {}

	project(
		state: RuntimeShellState,
		sessions: MycliShellSession[] = [],
		transcriptUpdate: RuntimeTranscriptUpdateKind = "replace",
	): MycliShellState {
		let projection: RuntimeTranscriptProjection | null = null;
		let activeAssistantSourceIndex: number | null | undefined;
		if (this.cache && projectionContextMatches(this.cache, state)) {
			if (transcriptUpdate === "unchanged" && unchangedProjectionSource(this.cache, state)) {
				projection = this.cache.projection;
			} else if (transcriptUpdate === "tail") {
				const tail = projectRuntimeTranscriptTail(state, this.cache, this.presentState);
				projection = tail?.projection ?? null;
				activeAssistantSourceIndex = tail?.activeAssistantSourceIndex;
			}
		}

		if (!projection) {
			projection = projectRuntimeTranscriptRange(state, 0, this.presentState);
		}
		if (projection !== this.cache?.projection) {
			this.cache = runtimeTranscriptProjectionCache(
				state,
				projection,
				this.presentState,
				activeAssistantSourceIndex,
			);
		}
		return this.presentState(state, sessions, projection);
	}
}

function unchangedProjectionSource(
	cache: RuntimeTranscriptProjectionCache,
	state: RuntimeShellState,
): boolean {
	return cache.sourceTranscript === state.transcript &&
		cache.activeAssistantItemId === state.activeAssistantItemId &&
		cache.liveReasoningText === state.liveReasoning?.text &&
		cache.liveReasoningKind === state.liveReasoning?.kind;
}

function projectionContextMatches(
	cache: RuntimeTranscriptProjectionCache,
	state: RuntimeShellState,
): boolean {
	return cache.workspace === state.workspace &&
		cache.turnRunning === state.turnRunning &&
		cache.toolDetailsDefault === state.settings.toolDetailsDefault;
}

function projectRuntimeTranscriptTail(
	state: RuntimeShellState,
	cache: RuntimeTranscriptProjectionCache,
	presentState: RuntimeShellStatePresenter,
): { projection: RuntimeTranscriptProjection; activeAssistantSourceIndex?: number | null } | null {
	const source = state.transcript;
	if (source.length < cache.sourceLength) return null;
	if (
		cache.sourceLength > 0 &&
		source.length > cache.sourceLength &&
		source[cache.sourceLength - 1] !== cache.lastSourceItem
	) return null;
	if (
		source.length === cache.sourceLength &&
		source.length > 1 &&
		source[source.length - 2] !== cache.penultimateSourceItem
	) return null;

	let sourceStart = source.length > cache.sourceLength ? cache.sourceLength : source.length;
	let prefix = projectionCounts(cache.projection);
	if (
		source.length === cache.sourceLength &&
		source.length > 0 &&
		source[source.length - 1] !== cache.lastSourceItem
	) {
		sourceStart = source.length - 1;
		prefix = cache.lastSourcePrefix;
	}

	const reasoningChanged =
		cache.liveReasoningText !== state.liveReasoning?.text ||
		cache.liveReasoningKind !== state.liveReasoning?.kind;
	const activeAssistantChanged = cache.activeAssistantItemId !== state.activeAssistantItemId;
	if (reasoningChanged || activeAssistantChanged) {
		if (
			activeAssistantChanged ||
			cache.activeAssistantSourceIndex === null ||
			cache.activeAssistantPrefix === null
		) return null;
		if (cache.activeAssistantSourceIndex < sourceStart) {
			sourceStart = cache.activeAssistantSourceIndex;
			prefix = cache.activeAssistantPrefix;
		}
	}

	if (sourceStart === source.length) {
		return { projection: cache.projection, activeAssistantSourceIndex: cache.activeAssistantSourceIndex };
	}
	const suffix = projectRuntimeTranscriptRange(state, sourceStart, presentState);
	return {
		projection: combineRuntimeTranscriptProjection(cache.projection, prefix, suffix),
		activeAssistantSourceIndex: cache.activeAssistantSourceIndex,
	};
}

function combineRuntimeTranscriptProjection(
	previous: RuntimeTranscriptProjection,
	prefix: RuntimeProjectionCounts,
	suffix: RuntimeTranscriptProjection,
): RuntimeTranscriptProjection {
	return {
		messages: combineRuntimeProjectionArray(previous.messages, prefix.messages, suffix.messages),
		tools: combineRuntimeProjectionArray(previous.tools, prefix.tools, suffix.tools),
		bash: combineRuntimeProjectionArray(previous.bash, prefix.bash, suffix.bash),
		transcript: combineRuntimeProjectionArray(previous.transcript, prefix.transcript, suffix.transcript),
	};
}

function combineRuntimeProjectionArray<T>(previous: T[], prefixLength: number, suffix: T[]): T[] {
	if (prefixLength === previous.length && suffix.length === 0) return previous;
	if (prefixLength === previous.length - 1 && suffix.length === 1) {
		return previous.with(-1, suffix[0]!);
	}
	if (prefixLength === previous.length) return previous.concat(suffix);
	return [...previous.slice(0, prefixLength), ...suffix];
}

function runtimeTranscriptProjectionCache(
	state: RuntimeShellState,
	projection: RuntimeTranscriptProjection,
	presentState: RuntimeShellStatePresenter,
	activeAssistantSourceIndexHint?: number | null,
): RuntimeTranscriptProjectionCache {
	const source = state.transcript;
	const total = projectionCounts(projection);
	const lastSourceSuffix = source.length > 0
		? projectRuntimeTranscriptRange(state, source.length - 1, presentState)
		: emptyRuntimeTranscriptProjection();
	const lastSourcePrefix = subtractProjectionCounts(total, projectionCounts(lastSourceSuffix));
	const activeAssistantSourceIndex = resolveActiveAssistantSourceIndex(
		state,
		activeAssistantSourceIndexHint,
	);
	const activeAssistantSuffix = activeAssistantSourceIndex === null
		? null
		: activeAssistantSourceIndex === source.length - 1
			? lastSourceSuffix
			: projectRuntimeTranscriptRange(state, activeAssistantSourceIndex, presentState);
	return {
		projection,
		sourceTranscript: source,
		sourceLength: source.length,
		penultimateSourceItem: source.length >= 2 ? source[source.length - 2] : undefined,
		lastSourceItem: source.at(-1),
		lastSourcePrefix,
		activeAssistantItemId: state.activeAssistantItemId,
		activeAssistantSourceIndex,
		activeAssistantPrefix: activeAssistantSuffix
			? subtractProjectionCounts(total, projectionCounts(activeAssistantSuffix))
			: null,
		liveReasoningText: state.liveReasoning?.text,
		liveReasoningKind: state.liveReasoning?.kind,
		workspace: state.workspace,
		turnRunning: state.turnRunning,
		toolDetailsDefault: state.settings.toolDetailsDefault,
	};
}

function resolveActiveAssistantSourceIndex(
	state: RuntimeShellState,
	hint?: number | null,
): number | null {
	const activeId = state.activeAssistantItemId;
	if (!activeId) return null;
	if (hint !== undefined && hint !== null && state.transcript[hint]?.id === activeId) return hint;
	const index = state.transcript.findLastIndex((item) => item.id === activeId);
	return index >= 0 ? index : null;
}

function projectRuntimeTranscriptRange(
	state: RuntimeShellState,
	sourceStart: number,
	presentState: RuntimeShellStatePresenter,
): RuntimeTranscriptProjection {
	const shell = presentState(state, [], undefined, sourceStart);
	return {
		messages: shell.messages,
		tools: shell.tools,
		bash: shell.bash,
		transcript: shell.transcript ?? [],
	};
}

function emptyRuntimeTranscriptProjection(): RuntimeTranscriptProjection {
	return { messages: [], tools: [], bash: [], transcript: [] };
}

function projectionCounts(projection: RuntimeTranscriptProjection): RuntimeProjectionCounts {
	return {
		messages: projection.messages.length,
		tools: projection.tools.length,
		bash: projection.bash.length,
		transcript: projection.transcript.length,
	};
}

function subtractProjectionCounts(
	total: RuntimeProjectionCounts,
	suffix: RuntimeProjectionCounts,
): RuntimeProjectionCounts {
	return {
		messages: total.messages - suffix.messages,
		tools: total.tools - suffix.tools,
		bash: total.bash - suffix.bash,
		transcript: total.transcript - suffix.transcript,
	};
}
