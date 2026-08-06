import type { SubagentProfile } from "./types.ts";

export const GLOBAL_CHILD_TOOL_DENYLIST: readonly string[] = Object.freeze([
	"Task",
	"SubagentOutput",
	"SendMessage",
	"AskUserQuestion",
]);

export const BUILTIN_SUBAGENT_PROFILES: readonly SubagentProfile[] = Object.freeze([
	builtinProfile({
		id: "executor",
		description: "Make scoped workspace changes and report the changed paths.",
		prompt: [
			"You are a bounded execution subagent.",
			"Make small scoped changes only and return concise findings and changed paths.",
			"Do not ask the user questions or start another subagent.",
		].join(" "),
		allowedTools: ["Read", "Edit", "Patch", "Write"],
	}),
	builtinProfile({
		id: "explore",
		description: "Inspect repository files and return grounded findings.",
		prompt: [
			"You are a read-only exploration subagent.",
			"Map files, symbols, and facts without modifying the workspace.",
			"Do not ask the user questions or start another subagent.",
		].join(" "),
		allowedTools: ["Read"],
	}),
	builtinProfile({
		id: "review",
		description: "Review changes for correctness, regressions, security, and missing tests.",
		prompt: [
			"You are a read-only code review subagent.",
			"Prioritize correctness, regressions, security, and missing tests.",
			"Do not modify files, ask the user questions, or start another subagent.",
		].join(" "),
		allowedTools: ["Read"],
	}),
]);

function builtinProfile(input: {
	readonly id: string;
	readonly description: string;
	readonly prompt: string;
	readonly allowedTools: readonly string[];
}): SubagentProfile {
	return Object.freeze({
		...input,
		allowedTools: Object.freeze([...input.allowedTools]),
		deniedTools: GLOBAL_CHILD_TOOL_DENYLIST,
		budget: Object.freeze({}),
		sourceKind: "builtin",
		sourceDirectory: "builtin",
		fileLabel: `builtin:${input.id}`,
	});
}
