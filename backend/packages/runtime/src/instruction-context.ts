import {
	modelInputSha256,
	orderInstructionFragments,
	stableModelInputJson,
} from "@mycli/core";
import type {
	CanonicalConversationItem,
	InstructionContract,
	InstructionFragment,
	InstructionFragmentKind,
	InstructionSnapshot,
	ToolDefinition,
	TurnContextSection,
} from "@mycli/core";
import {
	fenceWorkspaceInstructions,
} from "./workspace-instructions.ts";
import type { LoadedWorkspaceInstructions } from "./workspace-instructions.ts";
import { collaborationModeDeveloperInstruction } from "./collaboration-mode.ts";

export type RuntimeHookPoint = "user_prompt_submit" | "pre_tool_use" | "post_tool_use";

export interface RuntimeHookContext {
	readonly point: RuntimeHookPoint;
	readonly content: string;
	readonly source: string;
	readonly trusted: boolean;
	readonly policyProducing: boolean;
}

export interface LoadedSkillInstructions {
	readonly skillId: string;
	readonly content: string;
}

export interface TurnContextSources {
	readonly collaborationMode?: string;
	readonly permissionContext?: string;
	readonly tools?: readonly ToolDefinition[];
	readonly skillCatalog?: string;
	readonly loadedSkillInstructions?: readonly LoadedSkillInstructions[];
	readonly workspace?: LoadedWorkspaceInstructions;
	readonly environment?: Readonly<Record<string, string>>;
	readonly conversationContext?: string;
	readonly compactionRehydration?: readonly string[];
	readonly memory?: readonly string[];
	readonly plan?: string;
	readonly hooks?: readonly RuntimeHookContext[];
	readonly runtimePolicyReminders?: readonly string[];
	readonly runtimeContextReminders?: readonly string[];
	readonly subagentContext?: string;
}

export interface TurnContext {
	readonly sections: readonly TurnContextSection[];
	readonly conversationItems: readonly CanonicalConversationItem[];
	readonly currentUserRequest: string;
}

export interface CollectTurnContextInput {
	readonly sources: TurnContextSources;
	readonly conversationItems: readonly CanonicalConversationItem[];
	readonly currentUserRequest: string;
}

const DEVELOPER_KINDS = new Set<InstructionFragmentKind>([
	"collaboration_mode",
	"permissions",
	"tool_exposure",
	"skill_catalog",
	"runtime_policy_reminder",
	"subagent_context",
]);

export function collectTurnContext(input: CollectTurnContextInput): TurnContext {
	const sections: TurnContextSection[] = [];
	const add = (section: TurnContextSection): void => {
		if (!section.enabled || !section.content.trim()) return;
		sections.push(freezeSection(section));
	};
	if (input.sources.collaborationMode) {
		add(section({
			key: "collaboration-mode",
			kind: "collaboration_mode",
			title: "Collaboration mode",
			content: collaborationModeDeveloperInstruction(input.sources.collaborationMode),
			role: "developer",
			source: "runtime:collaboration-mode",
			cacheClass: "dynamic",
			scope: "turn",
			required: true,
		}));
	}
	if (input.sources.permissionContext) {
		add(section({
			key: "permissions",
			kind: "permissions",
			title: "Permissions",
			content: input.sources.permissionContext,
			role: "developer",
			source: "runtime:execution-policy",
			cacheClass: "dynamic",
			scope: "turn",
			required: true,
		}));
	}
	if (input.sources.tools) {
		add(section({
			key: "tool-exposure",
			kind: "tool_exposure",
			title: "Tool exposure",
			content: renderToolExposure(input.sources.tools),
			role: "developer",
			source: "runtime:tool-manifest",
			cacheClass: "dynamic",
			scope: "turn",
			required: true,
			metadata: { toolNames: input.sources.tools.map((tool) => tool.name).sort(compareText) },
		}));
	}
	if (input.sources.skillCatalog) {
		add(section({
			key: "skill-catalog",
			kind: "skill_catalog",
			title: "Skill catalog",
			content: input.sources.skillCatalog,
			role: "developer",
			source: "runtime:skill-catalog",
			cacheClass: "static",
			scope: "session",
		}));
	}
	for (const skill of [...(input.sources.loadedSkillInstructions ?? [])]
		.sort((left, right) => compareText(left.skillId, right.skillId))) {
		add(section({
			key: `skill:${safeKey(skill.skillId)}`,
			kind: "skill_instructions",
			title: `Skill instructions: ${skill.skillId}`,
			content: tagged("skill_instructions", skill.content),
			role: "user",
			source: `skill:${skill.skillId}`,
			cacheClass: "static",
			scope: "transcript",
			includeInMemory: true,
		}));
	}
	if (input.sources.workspace?.content) {
		add(section({
			key: "workspace-instructions",
			kind: "workspace_instructions",
			title: "Workspace instructions",
			content: fenceWorkspaceInstructions(input.sources.workspace.content),
			role: "user",
			source: input.sources.workspace.diagnostics.selectedSource
				? `context-file:${input.sources.workspace.diagnostics.selectedSource}`
				: "context-file",
			cacheClass: "static",
			scope: "transcript",
			includeInMemory: true,
			metadata: { diagnostics: input.sources.workspace.diagnostics },
		}));
	}
	const environment = renderEnvironment(input.sources.environment);
	if (environment) {
		add(section({
			key: "environment-context",
			kind: "environment_context",
			title: "Environment context",
			content: tagged("environment_context", environment),
			role: "user",
			source: "runtime:environment",
			cacheClass: "dynamic",
			scope: "turn",
		}));
	}
	if (input.sources.conversationContext) {
		add(section({
			key: "conversation-context",
			kind: "conversation_context",
			title: "Conversation context",
			content: tagged("conversation_context", input.sources.conversationContext),
			role: "user",
			source: "runtime:conversation-context",
			cacheClass: "dynamic",
			scope: "turn",
		}));
	}
	const compaction = renderList(input.sources.compactionRehydration);
	if (compaction) {
		add(section({
			key: "compaction-rehydration",
			kind: "compaction_rehydration",
			title: "Compaction rehydration",
			content: tagged("compaction_rehydration", compaction),
			role: "user",
			source: "runtime:compaction",
			cacheClass: "dynamic",
			scope: "turn",
		}));
	}
	const memory = renderList(input.sources.memory);
	if (memory) {
		add(section({
			key: "memory",
			kind: "memory",
			title: "Memory",
			content: tagged("memory_context", memory),
			role: "user",
			source: "runtime:memory",
			cacheClass: "dynamic",
			scope: "transcript",
			includeInMemory: true,
		}));
	}
	if (input.sources.plan) {
		add(section({
			key: "plan",
			kind: "plan",
			title: "Plan",
			content: tagged("plan_context", input.sources.plan),
			role: "user",
			source: "runtime:plan",
			cacheClass: "dynamic",
			scope: "transcript",
		}));
	}
	for (const hook of hookSections(input.sources.hooks ?? [])) add(hook);
	const policyReminders = renderList(input.sources.runtimePolicyReminders);
	if (policyReminders) {
		add(section({
			key: "runtime-policy-reminders",
			kind: "runtime_policy_reminder",
			title: "Runtime policy reminders",
			content: tagged("runtime_policy_reminders", policyReminders),
			role: "developer",
			source: "runtime:policy-reminders",
			cacheClass: "ephemeral",
			scope: "turn",
			required: true,
		}));
	}
	const contextReminders = renderList(input.sources.runtimeContextReminders);
	if (contextReminders) {
		add(section({
			key: "runtime-context-reminders",
			kind: "runtime_context_reminder",
			title: "Runtime context reminders",
			content: tagged("runtime_context_reminders", contextReminders),
			role: "user",
			source: "runtime:context-reminders",
			cacheClass: "ephemeral",
			scope: "turn",
		}));
	}
	if (input.sources.subagentContext) {
		add(section({
			key: "subagent-context",
			kind: "subagent_context",
			title: "Subagent context",
			content: tagged("subagent_context", input.sources.subagentContext),
			role: "developer",
			source: "runtime:subagent",
			cacheClass: "dynamic",
			scope: "session",
			required: true,
		}));
	}
	return Object.freeze({
		sections: Object.freeze(sections),
		conversationItems: immutableClone(input.conversationItems),
		currentUserRequest: input.currentUserRequest,
	});
}

export class InstructionContractAssembler {
	assemble(input: {
		readonly baseInstructions: InstructionSnapshot;
		readonly turnContext: TurnContext;
	}): InstructionContract {
		const byKey = new Map<string, TurnContextSection>();
		for (const section of input.turnContext.sections) {
			if (!section.enabled) continue;
			if (section.durability !== "persistent") {
				throw new TypeError("model-visible context must be durable");
			}
			assertSectionAuthority(section);
			const existing = byKey.get(section.key);
			if (existing) {
				if (stableModelInputJson(existing) !== stableModelInputJson(section)) {
					throw new TypeError("turn context contains conflicting section keys");
				}
				continue;
			}
			byKey.set(section.key, section);
		}
		const fragments: InstructionFragment[] = [];
		const identities = new Set<string>();
		for (const section of byKey.values()) {
			const contentSha256 = modelInputSha256(section.content);
			const identity = `${section.role}:${section.kind}:${contentSha256}`;
			if (identities.has(identity)) continue;
			identities.add(identity);
			fragments.push(Object.freeze({
				fragmentId: `fragment:${modelInputSha256({
					key: section.key,
					kind: section.kind,
					role: section.role,
					content_sha256: contentSha256,
				})}`,
				key: section.key,
				kind: section.kind,
				title: section.title,
				content: section.content,
				contentSha256,
				role: section.role,
				source: section.source,
				cacheClass: section.cacheClass,
				durability: section.durability,
				scope: section.scope,
				includeInMemory: section.includeInMemory,
				required: section.required,
				...(section.metadata ? { metadata: immutableClone(section.metadata) } : {}),
			}));
		}
		const ordered = orderInstructionFragments(fragments);
		return Object.freeze({
			baseInstructions: input.baseInstructions,
			developerSections: Object.freeze(ordered.filter((fragment) => fragment.role === "developer")),
			contextualUserSections: Object.freeze(ordered.filter((fragment) => fragment.role === "user")),
			conversationItems: immutableClone(input.turnContext.conversationItems),
			currentUserRequest: input.turnContext.currentUserRequest,
		});
	}
}

function section(
	input: Omit<
		TurnContextSection,
		"durability" | "includeInMemory" | "enabled" | "metadata" | "required"
	> & {
		readonly durability?: TurnContextSection["durability"];
		readonly includeInMemory?: boolean;
		readonly metadata?: Readonly<Record<string, unknown>>;
		readonly required?: boolean;
	},
): TurnContextSection {
	return {
		...input,
		durability: input.durability ?? "persistent",
		includeInMemory: input.includeInMemory ?? false,
		required: input.required ?? false,
		enabled: true,
	};
}

function hookSections(hooks: readonly RuntimeHookContext[]): readonly TurnContextSection[] {
	const deduplicated = new Map<string, RuntimeHookContext>();
	for (const hook of hooks) {
		const content = hook.content.trim();
		if (!content) continue;
		const normalized = Object.freeze({ ...hook, content });
		deduplicated.set(modelInputSha256(normalized), normalized);
	}
	return Object.freeze([...deduplicated.values()]
		.sort((left, right) => (
			compareText(left.point, right.point)
			|| compareText(left.source, right.source)
			|| compareText(left.content, right.content)
		))
		.map((hook) => {
			const developer = hook.trusted && hook.policyProducing;
			return section({
				key: `hook:${modelInputSha256(hook)}`,
				kind: "hook_context",
				title: `Hook context: ${hook.point}`,
				content: tagged("hook_context", hook.content),
				role: developer ? "developer" : "user",
				source: hook.source,
				cacheClass: "ephemeral",
				scope: "turn",
				required: developer,
				metadata: {
					point: hook.point,
					trusted: hook.trusted,
					policyProducing: hook.policyProducing,
				},
			});
		}));
}

function assertSectionAuthority(section: TurnContextSection): void {
	if (section.role !== "developer") return;
	if (section.kind === "hook_context") {
		if (section.metadata?.trusted !== true || section.metadata.policyProducing !== true) {
			throw new TypeError("untrusted hook context cannot use developer authority");
		}
		return;
	}
	if (!DEVELOPER_KINDS.has(section.kind)) {
		throw new TypeError("context source cannot use developer authority");
	}
}

function freezeSection(value: TurnContextSection): TurnContextSection {
	return Object.freeze({
		...value,
		...(value.metadata ? { metadata: immutableClone(value.metadata) } : {}),
	});
}

function renderToolExposure(tools: readonly ToolDefinition[]): string {
	const names = [...new Set(tools.map((tool) => tool.name))].sort(compareText);
	return names.length > 0
		? tagged("tool_exposure", `Available tools: ${names.join(", ")}`)
		: tagged("tool_exposure", "No tools are exposed for this turn.");
}

function renderEnvironment(value: Readonly<Record<string, string>> | undefined): string {
	if (!value) return "";
	return Object.entries(value)
		.filter(([, item]) => item.trim())
		.sort(([left], [right]) => compareText(left, right))
		.map(([key, item]) => `${key}: ${item}`)
		.join("\n");
}

function renderList(values: readonly string[] | undefined): string {
	return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
		.map((value) => `- ${value}`)
		.join("\n");
}

function tagged(tag: string, content: string): string {
	return `<${tag}>\n${content.trim()}\n</${tag}>`;
}

function safeKey(value: string): string {
	const normalized = value.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 96);
	return normalized || modelInputSha256(value).slice(0, 16);
}

function immutableClone<Value>(value: Value): Value {
	return deepFreeze(JSON.parse(stableModelInputJson(value)) as Value);
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function compareText(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}
