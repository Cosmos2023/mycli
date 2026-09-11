import type {
	ToolAdapter,
	ToolAdapterResult,
} from "../types.ts";
import { ASK_USER_QUESTION_TOOL_DEFINITION } from "../registry/manifest.ts";

const MAX_QUESTION_CHARS = 4_096;
const MAX_HEADER_CHARS = 256;
const MAX_LABEL_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 512;

export class AskUserQuestionTool implements ToolAdapter {
	readonly definition = ASK_USER_QUESTION_TOOL_DEFINITION;

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
	): Promise<ToolAdapterResult> {
		const question = boundedRequired(argumentsValue.question, MAX_QUESTION_CHARS);
		const header = boundedOptional(argumentsValue.header, MAX_HEADER_CHARS);
		const multiSelect = argumentsValue.multi_select ?? false;
		const options = clarificationOptions(argumentsValue.options);
		if (!question || !options || typeof multiSelect !== "boolean") return invalidResult();
		return {
			success: true,
			modelOutput: "Awaiting user response.",
			summary: "Awaiting user response",
			metadata: Object.freeze({
				status: "awaiting_user_response",
				question,
				options: Object.freeze([
					...options,
					Object.freeze({ label: "Other", description: "Custom answer" }),
				]),
				header: header ?? "",
				multi_select: multiSelect,
			}),
		};
	}
}

function clarificationOptions(value: unknown): readonly Readonly<Record<string, string>>[] | undefined {
	if (!Array.isArray(value) || value.length < 2 || value.length > 4) return undefined;
	const options: Readonly<Record<string, string>>[] = [];
	for (const item of value) {
		if (!isRecord(item)) return undefined;
		const label = boundedRequired(item.label, MAX_LABEL_CHARS);
		const description = boundedOptional(item.description, MAX_DESCRIPTION_CHARS);
		if (!label) return undefined;
		options.push(Object.freeze({ label, ...(description ? { description } : {}) }));
	}
	return Object.freeze(options);
}

function invalidResult(): ToolAdapterResult {
	return {
		success: false,
		modelOutput: "AskUserQuestion failed\nError kind: invalid_arguments\nError: Invalid tool arguments.",
		summary: "AskUserQuestion failed",
		errorKind: "invalid_arguments",
		metadata: Object.freeze({}),
	};
}

function boundedRequired(value: unknown, limit: number): string | undefined {
	return typeof value === "string" && value.trim() && value.trim().length <= limit
		? value.trim()
		: undefined;
}

function boundedOptional(value: unknown, limit: number): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return boundedRequired(value, limit);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
