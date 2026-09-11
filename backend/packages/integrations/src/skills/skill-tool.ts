import { createHash } from "node:crypto";
import type { ToolDefinition } from "@mycli/core";
import { isSkillReferenceName } from "@mycli/core";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "@mycli/tools";
import { defineIntegrationRegistration } from "../foundation/registration.ts";
import type { IntegrationRegistration } from "../foundation/registration.ts";
import type { SkillInvocationArtifact, SkillSourceKind, SkillDefinition } from "./types.ts";

export interface SkillLookup {
	get(name: string): SkillDefinition | undefined;
}

export interface SkillToolOptions {
	readonly registry: SkillLookup;
}

export const SKILL_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "skill:Skill",
	name: "Skill",
	description: "Load detailed instructions for one named skill from the available skill catalog into the current turn.",
	inputSchema: {
		type: "object",
		properties: {
			name: {
				type: "string",
				minLength: 1,
				description: "Exact skill name from the model-visible skill catalog.",
			},
			reason: {
				type: "string",
				description: "Optional compatibility context for why the skill is being loaded; it does not affect skill selection.",
			},
		},
		required: ["name"],
		additionalProperties: false,
	},
});

const SKILL_SOURCE_KINDS = new Set(["builtin", "user", "shared_repo", "repo"]);
const MAX_SKILL_BODY_CHARS = 65_536;
const MAX_SKILL_CONTEXT_CHARS = 131_072;

export class SkillTool implements ToolAdapter {
	readonly definition = SKILL_TOOL_DEFINITION;
	readonly #registry: SkillLookup;

	constructor(options: SkillToolOptions) {
		this.#registry = options.registry;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		if (options.signal.aborted) {
			const error = new Error("interrupted");
			error.name = "AbortError";
			throw error;
		}
		const name = typeof argumentsValue.name === "string" ? argumentsValue.name.trim() : "";
		const skill = name ? this.#registry.get(name) : undefined;
		if (!skill) {
			return Object.freeze({
				success: false,
				modelOutput: "Skill activation failed: skill_not_found",
				summary: "Skill activation failed",
				errorKind: "skill_not_found",
				metadata: Object.freeze({}),
			});
		}
		const artifact = instructionArtifact(skill.name, skill.body, skill.sourceKind);
		return Object.freeze({
			success: true,
			modelOutput: `Activated skill: ${skill.name}`,
			summary: `Activated skill: ${skill.name}`,
			metadata: Object.freeze({ skillInvocationArtifact: artifact }),
		});
	}
}

export function createSkillToolRegistration(registry: SkillLookup): IntegrationRegistration {
	const adapter = new SkillTool({ registry });
	return defineIntegrationRegistration({
		id: SKILL_TOOL_DEFINITION.id,
		source: "skill",
		definition: SKILL_TOOL_DEFINITION,
		adapter,
		originMetadata: { skill: "catalog" },
	});
}

export function skillInvocationArtifactFromMetadata(
	metadata: Readonly<Record<string, unknown>>,
): SkillInvocationArtifact | undefined {
	const value = metadata.skillInvocationArtifact;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const artifact = value as Partial<SkillInvocationArtifact>;
	return artifact.kind === "skill_instructions"
		&& typeof artifact.name === "string"
		&& isSkillReferenceName(artifact.name)
		&& typeof artifact.text === "string"
		&& artifact.text.length <= MAX_SKILL_CONTEXT_CHARS
		&& isSkillSourceKind(artifact.sourceKind)
		&& typeof artifact.contentSha256 === "string"
		&& /^[a-f0-9]{64}$/u.test(artifact.contentSha256)
		&& typeof artifact.contentLength === "number"
		&& Number.isSafeInteger(artifact.contentLength)
		&& artifact.contentLength >= 0
		&& artifact.contentLength <= MAX_SKILL_BODY_CHARS
		? Object.freeze({
			kind: artifact.kind,
			name: artifact.name,
			text: artifact.text,
			sourceKind: artifact.sourceKind,
			contentSha256: artifact.contentSha256,
			contentLength: artifact.contentLength,
		})
		: undefined;
}

function isSkillSourceKind(value: unknown): value is SkillSourceKind {
	return typeof value === "string" && SKILL_SOURCE_KINDS.has(value);
}

function instructionArtifact(
	name: string,
	body: string,
	sourceKind: SkillInvocationArtifact["sourceKind"],
): SkillInvocationArtifact {
	return Object.freeze({
		kind: "skill_instructions",
		name,
		text: [
			`<loaded-skill name="${name}" source="${sourceKind}">`,
			"This is a loaded skill reference, not the current user request.",
			body,
			"</loaded-skill>",
		].join("\n"),
		sourceKind,
		contentSha256: createHash("sha256").update(body, "utf8").digest("hex"),
		contentLength: body.length,
	});
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}
