import type { AppendContextItemInput } from "@mycli/storage";
import type { ToolExecutionResult } from "@mycli/tools";

export interface SkillContextArtifact {
	readonly kind: "skill_instructions";
	readonly name: string;
	readonly text: string;
	readonly sourceKind: string;
	readonly contentSha256: string;
	readonly contentLength: number;
}

export interface ContextItemCoordinatorOptions {
	readonly extractArtifact: (
		metadata: Readonly<Record<string, unknown>>,
	) => SkillContextArtifact | undefined;
}

export interface ContextItemForToolResultInput {
	readonly turnId: string;
	readonly result: ToolExecutionResult;
}

export interface ContextItemCoordinatorContract {
	contextItemFor(
		input: ContextItemForToolResultInput,
	): Omit<AppendContextItemInput, "sessionId"> | undefined;
}

const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SAFE_SOURCE_KINDS = new Set(["builtin", "user", "shared_repo", "repo"]);
const MAX_CONTEXT_CHARS = 131_072;
const MAX_CONTENT_CHARS = 65_536;

export class ContextItemCoordinator implements ContextItemCoordinatorContract {
	readonly #extractArtifact: ContextItemCoordinatorOptions["extractArtifact"];

	constructor(options: ContextItemCoordinatorOptions) {
		this.#extractArtifact = options.extractArtifact;
	}

	contextItemFor(
		input: ContextItemForToolResultInput,
	): Omit<AppendContextItemInput, "sessionId"> | undefined {
		if (!input.result.success) return undefined;
		const artifact = this.#extractArtifact(input.result.metadata);
		if (!validArtifact(artifact)) return undefined;
		return deepFreeze({
			itemId: `${input.turnId}:skill:${artifact.name}:${input.result.callId}`,
			text: artifact.text,
			metadata: {
				kind: "skill_instructions",
				cacheClass: "dynamic",
				durability: "persistent",
				scope: "transcript",
				sourceId: artifact.name,
				contentSha256: artifact.contentSha256,
				contentLength: artifact.contentLength,
			},
		});
	}
}

function validArtifact(value: SkillContextArtifact | undefined): value is SkillContextArtifact {
	return value?.kind === "skill_instructions"
		&& SAFE_SKILL_NAME.test(value.name)
		&& typeof value.text === "string"
		&& value.text.length <= MAX_CONTEXT_CHARS
		&& SAFE_SOURCE_KINDS.has(value.sourceKind)
		&& /^[a-f0-9]{64}$/u.test(value.contentSha256)
		&& Number.isSafeInteger(value.contentLength)
		&& value.contentLength >= 0
		&& value.contentLength <= MAX_CONTENT_CHARS;
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}
