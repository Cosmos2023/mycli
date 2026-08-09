import {
	modelInputSha256,
	stableModelInputJson,
} from "@mycli/core";
import type {
	InstructionContract,
	InstructionFragment,
	InstructionFragmentKind,
	ToolDefinition,
} from "@mycli/core";
import { TokenCounter } from "./token-counter.ts";

export interface InstructionBudgetTrim {
	readonly key: string;
	readonly kind: InstructionFragmentKind;
	readonly originalTokens: number;
	readonly trimmedTokens: number;
	readonly originalChars: number;
	readonly trimmedChars: number;
}

export interface InstructionBudgetDiagnostic {
	readonly targetTokens: number;
	readonly beforeTokens: number;
	readonly afterTokens: number;
	readonly remainingTokens: number;
	readonly overflowTokens: number;
	readonly trims: readonly InstructionBudgetTrim[];
}

export interface BudgetInstructionContractInput {
	readonly contract: InstructionContract;
	readonly tools: readonly ToolDefinition[];
	readonly maxTokens: number;
	readonly tokenCounter?: TokenCounter;
}

export interface BudgetedInstructionContract {
	readonly contract: InstructionContract;
	readonly diagnostic: InstructionBudgetDiagnostic;
}

const TRIM_PRIORITY: Readonly<Partial<Record<InstructionFragmentKind, number>>> = Object.freeze({
	memory: 10,
	workspace_instructions: 20,
	skill_catalog: 25,
	skill_instructions: 26,
	conversation_context: 30,
	compaction_rehydration: 35,
	environment_context: 40,
	plan: 45,
	hook_context: 80,
	runtime_context_reminder: 90,
});
const MINIMUM_CHARS: Readonly<Partial<Record<InstructionFragmentKind, number>>> = Object.freeze({
	memory: 240,
	workspace_instructions: 320,
	skill_catalog: 240,
	skill_instructions: 320,
	conversation_context: 320,
	compaction_rehydration: 320,
	environment_context: 160,
	plan: 240,
	hook_context: 240,
	runtime_context_reminder: 240,
});

export function budgetInstructionContract(
	input: BudgetInstructionContractInput,
): BudgetedInstructionContract {
	if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0) {
		throw new RangeError("instruction budget must be a positive safe integer");
	}
	const counter = input.tokenCounter ?? new TokenCounter();
	const developerSections = [...input.contract.developerSections];
	const contextualUserSections = [...input.contract.contextualUserSections];
	const beforeTokens = contractTokens(input.contract, input.tools, counter);
	let currentTokens = beforeTokens;
	const trims: InstructionBudgetTrim[] = [];
	const candidates = [
		...developerSections.map((fragment, index) => ({ group: "developer" as const, index, fragment })),
		...contextualUserSections.map((fragment, index) => ({ group: "user" as const, index, fragment })),
	]
		.filter(({ fragment }) => isOptional(fragment))
		.sort((left, right) => (
			(TRIM_PRIORITY[left.fragment.kind] ?? 50) - (TRIM_PRIORITY[right.fragment.kind] ?? 50)
			|| compareText(left.fragment.key, right.fragment.key)
		));
	for (const candidate of candidates) {
		if (currentTokens <= input.maxTokens) break;
		const original = candidate.group === "developer"
			? developerSections[candidate.index]
			: contextualUserSections[candidate.index];
		if (!original) continue;
		const replacement = trimFragment(
			original,
			currentTokens - input.maxTokens,
			counter,
		);
		if (replacement.content === original.content) continue;
		if (candidate.group === "developer") developerSections[candidate.index] = replacement;
		else contextualUserSections[candidate.index] = replacement;
		const originalTokens = counter.count(original.content);
		const trimmedTokens = counter.count(replacement.content);
		currentTokens = Math.max(0, currentTokens - originalTokens + trimmedTokens);
		trims.push(Object.freeze({
			key: original.key,
			kind: original.kind,
			originalTokens,
			trimmedTokens,
			originalChars: Array.from(original.content).length,
			trimmedChars: Array.from(replacement.content).length,
		}));
	}
	const contract = Object.freeze({
		...input.contract,
		developerSections: Object.freeze(developerSections),
		contextualUserSections: Object.freeze(contextualUserSections),
	});
	const afterTokens = contractTokens(contract, input.tools, counter);
	return Object.freeze({
		contract,
		diagnostic: Object.freeze({
			targetTokens: input.maxTokens,
			beforeTokens,
			afterTokens,
			remainingTokens: Math.max(0, input.maxTokens - afterTokens),
			overflowTokens: Math.max(0, afterTokens - input.maxTokens),
			trims: Object.freeze(trims),
		}),
	});
}

function contractTokens(
	contract: InstructionContract,
	tools: readonly ToolDefinition[],
	counter: TokenCounter,
): number {
	return counter.count(contract.baseInstructions.content)
		+ counter.count(stableModelInputJson(tools))
		+ contract.developerSections.reduce((total, fragment) => total + counter.count(fragment.content), 0)
		+ contract.contextualUserSections.reduce((total, fragment) => total + counter.count(fragment.content), 0)
		+ counter.count(stableModelInputJson(contract.conversationItems))
		+ counter.count(contract.currentUserRequest);
}

function isOptional(fragment: InstructionFragment): boolean {
	return !fragment.required
		&& fragment.kind !== "permissions"
		&& fragment.kind !== "tool_exposure"
		&& fragment.kind !== "runtime_policy_reminder"
		&& fragment.kind !== "subagent_context";
}

function trimFragment(
	fragment: InstructionFragment,
	overflowTokens: number,
	counter: TokenCounter,
): InstructionFragment {
	const characters = Array.from(fragment.content);
	const minimum = Math.min(characters.length, MINIMUM_CHARS[fragment.kind] ?? 160);
	const estimatedRemoval = Math.min(
		characters.length,
		Math.max(overFlowChars(overflowTokens), Math.floor(characters.length / 2)),
	);
	const keep = Math.max(minimum, characters.length - estimatedRemoval);
	if (keep >= characters.length) return fragment;
	const omitted = characters.length - keep;
	const marker = Array.from(`\n\n[context section trimmed; ${omitted} chars omitted]\n\n`);
	const contentKeep = Math.max(0, keep - marker.length);
	const head = Math.floor(contentKeep / 2);
	const tail = contentKeep - head;
	const content = [
		...characters.slice(0, head),
		...marker,
		...(tail > 0 ? characters.slice(-tail) : []),
	].join("");
	if (counter.count(content) >= counter.count(fragment.content)) return fragment;
	const contentSha256 = modelInputSha256(content);
	return Object.freeze({
		...fragment,
		fragmentId: `fragment:${modelInputSha256({
			key: fragment.key,
			kind: fragment.kind,
			role: fragment.role,
			content_sha256: contentSha256,
		})}`,
		content,
		contentSha256,
		metadata: Object.freeze({
			...(fragment.metadata ?? {}),
			budgetTrimmed: true,
			originalChars: characters.length,
			trimmedChars: Array.from(content).length,
		}),
	});
}

function overFlowChars(overflowTokens: number): number {
	return Math.max(4, overflowTokens * 4);
}

function compareText(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}
