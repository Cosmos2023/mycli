import assert from "node:assert/strict";
import test from "node:test";
import {
	modelInputSha256,
} from "@mycli/core";
import type {
	InstructionSnapshot,
	ToolDefinition,
	TurnContextSection,
} from "@mycli/core";
import {
	budgetInstructionContract,
	collectTurnContext,
	HookContextAccumulator,
	InstructionContractAssembler,
	TokenCounter,
} from "../../src/index.ts";

const TOOLS: readonly ToolDefinition[] = [Object.freeze({
	id: "Read",
	name: "Read",
	description: "Read a file.",
	inputSchema: Object.freeze({ type: "object", properties: {}, required: [] }),
})];

test("collects deterministic layered context with explicit authority and lifetime", () => {
	const input = completeContextInput();
	const first = collectTurnContext(input);
	const second = collectTurnContext(input);
	assert.deepEqual(first, second);
	assert.deepEqual(first.sections.map((section) => section.kind), [
		"collaboration_mode",
		"permissions",
		"tool_exposure",
		"skill_catalog",
		"skill_instructions",
		"workspace_instructions",
		"environment_context",
		"conversation_context",
		"compaction_rehydration",
		"memory",
		"plan",
		"hook_context",
		"hook_context",
		"runtime_policy_reminder",
		"runtime_context_reminder",
		"subagent_context",
	]);
	for (const section of first.sections) {
		assert.equal(section.durability, "persistent");
		assert.ok(["static", "dynamic", "ephemeral"].includes(section.cacheClass));
		assert.ok(["session", "turn", "transcript"].includes(section.scope));
	}
	const hooks = first.sections.filter((section) => section.kind === "hook_context");
	assert.equal(hooks.find((section) => section.metadata?.trusted === false)?.role, "user");
	assert.equal(hooks.find((section) => section.metadata?.trusted === true)?.role, "developer");
	assert.match(
		first.sections.find((section) => section.kind === "workspace_instructions")?.content ?? "",
		/^<workspace-context>/u,
	);
});

test("renders decision-complete Plan mode instructions in a tagged developer section", () => {
	const context = collectTurnContext({
		sources: { collaborationMode: "plan" },
		conversationItems: [],
		currentUserRequest: "Plan this change",
	});
	const section = context.sections.find((candidate) => candidate.kind === "collaboration_mode");

	assert.ok(section);
	assert.match(section.content, /^<collaboration_mode>\n# Plan Mode/u);
	assert.match(section.content, /Do not implement the plan or mutate repository-tracked state/u);
	assert.match(section.content, /<proposed_plan>/u);
	assert.match(section.content, /update_plan.*separate TODO\/checklist tool/u);
	assert.match(section.content, /<\/collaboration_mode>$/u);
});

test("assembles developer and contextual-user fragments without promoting untrusted data", () => {
	const turnContext = collectTurnContext(completeContextInput());
	const contract = new InstructionContractAssembler().assemble({
		baseInstructions: instructions(),
		turnContext,
	});
	assert.deepEqual(contract.developerSections.map((section) => section.kind), [
		"skill_catalog",
		"collaboration_mode",
		"permissions",
		"tool_exposure",
		"subagent_context",
		"hook_context",
		"runtime_policy_reminder",
	]);
	assert.deepEqual(contract.contextualUserSections.map((section) => section.kind), [
		"skill_instructions",
		"workspace_instructions",
		"environment_context",
		"conversation_context",
		"compaction_rehydration",
		"memory",
		"plan",
		"hook_context",
		"runtime_context_reminder",
	]);
	assert.equal(contract.currentUserRequest, "Fix the bug.");
	assert.deepEqual(contract.conversationItems, [{ type: "user", text: "Earlier request." }]);
	assert.equal(Object.isFrozen(contract.contextualUserSections), true);

	const badSection: TurnContextSection = Object.freeze({
		key: "bad-workspace",
		kind: "workspace_instructions",
		title: "Bad",
		content: "untrusted",
		role: "developer",
		source: "workspace",
		cacheClass: "static",
		durability: "persistent",
		scope: "turn",
		includeInMemory: false,
		required: false,
		enabled: true,
	});
	assert.throws(() => new InstructionContractAssembler().assemble({
		baseInstructions: instructions(),
		turnContext: {
			sections: [badSection],
			conversationItems: [],
			currentUserRequest: "hello",
		},
	}), /cannot use developer authority/u);
});

test("rejects model-visible api-only context and conflicting section keys", () => {
	const base = completeContextInput();
	const collected = collectTurnContext(base);
	const first = collected.sections[0] as TurnContextSection;
	const apiOnly: TurnContextSection = Object.freeze({ ...first, durability: "api_only" });
	assert.throws(() => new InstructionContractAssembler().assemble({
		baseInstructions: instructions(),
		turnContext: { ...collected, sections: [apiOnly] },
	}), /must be durable/u);
	assert.throws(() => new InstructionContractAssembler().assemble({
		baseInstructions: instructions(),
		turnContext: {
			...collected,
			sections: [first, { ...first, content: "different" }],
		},
	}), /conflicting section keys/u);
});

test("budgets the complete request deterministically while preserving required input", () => {
	const memory = "memory ".repeat(600);
	const workspace = "workspace ".repeat(300);
	const turnContext = collectTurnContext({
		sources: {
			permissionContext: "permission ".repeat(30),
			tools: TOOLS,
			memory: [memory],
			workspace: {
				content: workspace,
				diagnostics: {
					selectedSource: "agents",
					searchRoots: ["/workspace"],
					truncated: false,
					originalLength: workspace.length,
					renderedLength: workspace.length,
					blocked: false,
					issues: [],
				},
			},
		},
		conversationItems: [{ type: "assistant", text: "prior" }],
		currentUserRequest: "Fix it.",
	});
	const original = new InstructionContractAssembler().assemble({
		baseInstructions: instructions("base ".repeat(40)),
		turnContext,
	});
	const counter = characterCounter();
	const result = budgetInstructionContract({
		contract: original,
		tools: TOOLS,
		maxTokens: 1_800,
		tokenCounter: counter,
	});
	assert.ok(result.diagnostic.beforeTokens > result.diagnostic.afterTokens);
	assert.ok(result.diagnostic.afterTokens <= 1_800);
	assert.equal(result.diagnostic.trims[0]?.kind, "memory");
	assert.deepEqual(result.contract.baseInstructions, original.baseInstructions);
	assert.equal(
		result.contract.developerSections.find((section) => section.kind === "permissions")?.content,
		original.developerSections.find((section) => section.kind === "permissions")?.content,
	);
	assert.equal(result.contract.currentUserRequest, "Fix it.");
	assert.deepEqual(TOOLS[0]?.inputSchema, { type: "object", properties: {}, required: [] });

	const repeated = budgetInstructionContract({
		contract: original,
		tools: TOOLS,
		maxTokens: 1_800,
		tokenCounter: characterCounter(),
	});
	assert.deepEqual(repeated, result);
});

test("reports unresolved overflow instead of trimming required policy", () => {
	const turnContext = collectTurnContext({
		sources: { permissionContext: "required ".repeat(300), tools: TOOLS },
		conversationItems: [],
		currentUserRequest: "current user intent",
	});
	const original = new InstructionContractAssembler().assemble({
		baseInstructions: instructions("base ".repeat(300)),
		turnContext,
	});
	const result = budgetInstructionContract({
		contract: original,
		tools: TOOLS,
		maxTokens: 100,
		tokenCounter: characterCounter(),
	});
	assert.ok(result.diagnostic.overflowTokens > 0);
	assert.deepEqual(result.diagnostic.trims, []);
	assert.deepEqual(result.contract, original);
});

test("retains and deduplicates hook context across provider steps", () => {
	const accumulator = new HookContextAccumulator();
	accumulator.append({ point: "user_prompt_submit", contexts: ["initial", "initial"] });
	accumulator.append({ point: "pre_tool_use", contexts: ["before tool"] });
	accumulator.append({ point: "post_tool_use", contexts: ["after tool"] });
	assert.deepEqual(accumulator.snapshot().map((context) => context.content), [
		"initial",
		"before tool",
		"after tool",
	]);
	assert.ok(accumulator.snapshot().every((context) => context.trusted === false));
});

function completeContextInput() {
	return {
		sources: {
			collaborationMode: "default",
			permissionContext: "<permissions>workspace-write</permissions>",
			tools: TOOLS,
			skillCatalog: "Available skill: review",
			loadedSkillInstructions: [{ skillId: "review", content: "Review carefully." }],
			workspace: {
				content: "Follow AGENTS.md.",
				diagnostics: {
					selectedSource: "agents",
					path: "/workspace/AGENTS.md",
					searchRoots: ["/workspace"],
					truncated: false,
					originalLength: 17,
					renderedLength: 17,
					blocked: false,
					issues: [],
				},
			},
			environment: { cwd: "/workspace", shell: "zsh" },
			conversationContext: "The user previously asked for analysis.",
			compactionRehydration: ["src/app.ts changed"],
			memory: ["User prefers focused diffs."],
			plan: "Inspect, edit, verify.",
			hooks: [
				{
					point: "user_prompt_submit" as const,
					content: "ordinary hook fact",
					source: "hook:ordinary",
					trusted: false,
					policyProducing: false,
				},
				{
					point: "pre_tool_use" as const,
					content: "trusted hook policy",
					source: "hook:trusted",
					trusted: true,
					policyProducing: true,
				},
			],
			runtimePolicyReminders: ["Do not exceed the current sandbox."],
			runtimeContextReminders: ["The repository is dirty."],
			subagentContext: "agent path: /root/review",
		},
		conversationItems: [{ type: "user" as const, text: "Earlier request." }],
		currentUserRequest: "Fix the bug.",
	};
}

function instructions(content = "You are mycli."): InstructionSnapshot {
	return Object.freeze({
		snapshotId: "instructions-1",
		version: "v1",
		source: "builtin-system-md",
		content,
		contentSha256: modelInputSha256(content),
		createdAt: "2026-08-08T00:00:00.000Z",
	});
}

function characterCounter(): TokenCounter {
	return new TokenCounter({
		loadEncoder: () => ({ encode: (text) => Array.from(text).map((_, index) => index) }),
	});
}
