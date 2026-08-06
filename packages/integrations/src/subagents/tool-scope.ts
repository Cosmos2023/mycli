import { GLOBAL_CHILD_TOOL_DENYLIST } from "./builtin-profiles.ts";

export interface ResolveChildToolsInput {
	readonly parentTools: readonly string[];
	readonly allowed: readonly string[];
	readonly denied: readonly string[];
	readonly policyDenied?: readonly string[];
	readonly knownTools?: readonly string[];
}

export interface ResolvedChildTools {
	readonly tools: readonly string[];
	readonly unknown: readonly string[];
}

const CURRENT_NODE_CHILD_TOOLS = Object.freeze([
	"Read",
	"Edit",
	"Patch",
	"Write",
	"Shell",
	"WriteStdin",
	"Skill",
	"Task",
	"SubagentOutput",
	"SendMessage",
	"AskUserQuestion",
]);

export function resolveChildTools(input: ResolveChildToolsInput): ResolvedChildTools {
	const parent = new Set(normalizedNames(input.parentTools));
	const allowed = normalizedNames(input.allowed);
	const denied = new Set([
		...normalizedNames(input.denied),
		...normalizedNames(input.policyDenied ?? []),
		...GLOBAL_CHILD_TOOL_DENYLIST,
	]);
	const known = new Set([
		...CURRENT_NODE_CHILD_TOOLS,
		...normalizedNames(input.knownTools ?? []),
		...parent,
	]);
	const tools = allowed.filter((name) => parent.has(name) && !denied.has(name));
	const unknown = allowed
		.filter((name) => !known.has(name))
		.sort(compareText);
	return Object.freeze({
		tools: Object.freeze(tools),
		unknown: Object.freeze(unknown),
	});
}

function normalizedNames(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
