import type { MycliShellBash, MycliShellState, MycliShellTool, MycliShellTranscriptBlock } from "../model.ts";
import type { TranscriptUpdateKind } from "../model.ts";

export type ToolDetailMode = "default" | "expanded" | "collapsed";

type ToolDetailOverrideMode = Exclude<ToolDetailMode, "default">;

type DetailArrayUpdate<T> = {
	values: T[];
	kind: "reuse" | "tail" | "append" | "replace";
	replaced?: T;
	added: T[];
};

type ToolDetailProjectionCache = {
	mode: ToolDetailOverrideMode;
	sourceTools: MycliShellTool[];
	tools: MycliShellTool[];
	toolById: Map<string, MycliShellTool>;
	sourceBash: MycliShellBash[];
	bash: MycliShellBash[];
	bashById: Map<string, MycliShellBash>;
	sourceTranscript?: MycliShellTranscriptBlock[];
	transcript?: MycliShellTranscriptBlock[];
};

function mapDetailArray<T>(source: T[], project: (value: T) => T): T[] {
	let result: T[] | null = null;
	for (let index = 0; index < source.length; index += 1) {
		const current = source[index]!;
		const projected = project(current);
		if (!result && projected !== current) result = source.slice(0, index);
		result?.push(projected);
	}
	return result ?? source;
}

function projectDetailArray<T>(
	source: T[],
	previousSource: T[] | undefined,
	previousValues: T[] | undefined,
	hint: TranscriptUpdateKind | undefined,
	project: (value: T) => T,
): DetailArrayUpdate<T> {
	if (previousSource && previousValues && source === previousSource) {
		return { values: previousValues, kind: "reuse", added: [] };
	}
	if (
		hint === "tail" &&
		previousSource &&
		previousValues &&
		previousSource.length === previousValues.length
	) {
		if (
			source.length === previousSource.length &&
			source.length > 0 &&
			(source.length === 1 || source[source.length - 2] === previousSource[previousSource.length - 2])
		) {
			if (source[source.length - 1] === previousSource[previousSource.length - 1]) {
				return { values: previousValues, kind: "reuse", added: [] };
			}
			const added = project(source[source.length - 1]!);
			return {
				values: previousValues.with(-1, added),
				kind: "tail",
				replaced: previousValues.at(-1),
				added: [added],
			};
		}
		if (
			source.length > previousSource.length &&
			(previousSource.length === 0 || source[previousSource.length - 1] === previousSource.at(-1))
		) {
			const added = mapDetailArray(source.slice(previousSource.length), project);
			return { values: previousValues.concat(added), kind: "append", added };
		}
	}
	const values = mapDetailArray(source, project);
	return { values, kind: "replace", added: values };
}

function detailIndex<T extends { id: string }>(
	update: DetailArrayUpdate<T>,
	previous: Map<string, T> | undefined,
): Map<string, T> {
	if (update.kind === "reuse" && previous) return previous;
	if ((update.kind === "tail" || update.kind === "append") && previous) {
		if (update.replaced && !update.added.some((item) => item.id === update.replaced?.id)) {
			previous.delete(update.replaced.id);
		}
		for (const item of update.added) previous.set(item.id, item);
		return previous;
	}
	return new Map(update.values.map((item) => [item.id, item]));
}

export class ToolDetailProjector {
	private cache: ToolDetailProjectionCache | null = null;

	project(state: MycliShellState, mode: ToolDetailMode, transcriptUpdate?: TranscriptUpdateKind): MycliShellState {
		if (mode === "default") {
			this.cache = null;
			return state;
		}
		const expanded = mode === "expanded";
		const retained = this.cache;
		const previous = retained?.mode === mode ? retained : null;
		const sourceTools = retained && state.tools === retained.tools
			? retained.sourceTools
			: state.tools;
		const sourceBash = retained && state.bash === retained.bash
			? retained.sourceBash
			: state.bash;
		const sourceTranscript = retained && state.transcript === retained.transcript
			? retained.sourceTranscript
			: state.transcript;
		const toolUpdate = projectDetailArray(
			sourceTools,
			previous?.sourceTools,
			previous?.tools,
			transcriptUpdate,
			(tool) => tool.expanded === expanded ? tool : { ...tool, expanded },
		);
		const bashUpdate = projectDetailArray(
			sourceBash,
			previous?.sourceBash,
			previous?.bash,
			transcriptUpdate,
			(item) => item.expanded === expanded ? item : { ...item, expanded },
		);
		const toolById = detailIndex(toolUpdate, previous?.toolById);
		const bashById = detailIndex(bashUpdate, previous?.bashById);
		const transcript = sourceTranscript
			? projectDetailArray(
				sourceTranscript,
				previous?.sourceTranscript,
				previous?.transcript,
				transcriptUpdate,
				(block) => {
					if (block.kind === "provider_attempt") {
						return block.providerAttempt.expanded === expanded ? block
							: { ...block, providerAttempt: { ...block.providerAttempt, expanded } };
					}
					if (block.kind === "tool") {
						const tool = toolById.get(block.tool.id) ?? (
							block.tool.expanded === expanded ? block.tool : { ...block.tool, expanded }
						);
						return tool === block.tool ? block : { ...block, tool };
					}
					if (block.kind === "bash") {
						const bash = bashById.get(block.bash.id) ?? (
							block.bash.expanded === expanded ? block.bash : { ...block.bash, expanded }
						);
						return bash === block.bash ? block : { ...block, bash };
					}
					return block;
				},
			).values
			: undefined;
		this.cache = {
			mode,
			sourceTools,
			tools: toolUpdate.values,
			toolById,
			sourceBash,
			bash: bashUpdate.values,
			bashById,
			sourceTranscript,
			transcript,
		};
		return {
			...state,
			tools: toolUpdate.values,
			bash: bashUpdate.values,
			transcript,
		};
	}
}
