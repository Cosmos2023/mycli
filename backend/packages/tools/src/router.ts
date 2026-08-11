import type {
	CanonicalToolCall,
	ToolDefinition,
} from "@mycli/core";
import { TOOL_RESULT_OUTPUT_MAX_CHARS } from "@mycli/core";
import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
	ToolAdapter,
	ToolExecutionOptions,
	ToolExecutionResult,
	ToolRouterContract,
} from "./types.ts";

export interface ToolRouterOptions {
	readonly adapters: readonly ToolAdapter[];
	readonly exposure: readonly ToolDefinition[];
	readonly parallelToolNames?: ReadonlySet<string>;
}

interface Route {
	readonly adapter: ToolAdapter;
	readonly validate: ValidateFunction;
}

export class ToolRouter implements ToolRouterContract {
	readonly #routes = new Map<string, Route>();
	readonly #parallelToolNames: ReadonlySet<string>;

	constructor(options: ToolRouterOptions) {
		this.#parallelToolNames = new Set(options.parallelToolNames ?? []);
		const ajv = new Ajv2020({ allErrors: true, strict: true });
		for (const adapter of options.adapters) {
			const name = adapter.definition.name;
			if (this.#routes.has(name)) {
				throw new Error(`duplicate_tool: ${boundedName(name)}`);
			}
			this.#routes.set(name, {
				adapter,
				validate: ajv.compile(adapter.definition.inputSchema),
			});
		}
	}

	supportsParallelToolCalls(call: CanonicalToolCall): boolean {
		return this.#routes.has(call.name) && this.#parallelToolNames.has(call.name);
	}

	async execute(
		call: CanonicalToolCall,
		options: ToolExecutionOptions,
	): Promise<ToolExecutionResult> {
		const route = this.#routes.get(call.name);
		if (!route) {
			return failure(call, "unknown_tool", "Tool is not available.");
		}
		const argumentsValue = parseArguments(call.argumentsJson);
		if (!argumentsValue || !route.validate(argumentsValue)) {
			return failure(call, "invalid_arguments", "Invalid tool arguments.");
		}
		const result = await route.adapter.execute(argumentsValue, options);
		const omittedChars = Math.max(0, result.modelOutput.length - TOOL_RESULT_OUTPUT_MAX_CHARS);
		return {
			...result,
			modelOutput: omittedChars > 0
				? result.modelOutput.slice(0, TOOL_RESULT_OUTPUT_MAX_CHARS)
				: result.modelOutput,
			metadata: omittedChars > 0
				? Object.freeze({
					...result.metadata,
					model_output_truncated: true,
					model_output_omitted_chars: omittedChars,
				})
				: result.metadata,
			callId: call.callId,
			toolName: call.name,
		};
	}
}

function parseArguments(value: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		return parsed as Readonly<Record<string, unknown>>;
	} catch {
		return undefined;
	}
}

function failure(
	call: CanonicalToolCall,
	errorKind: string,
	message: string,
): ToolExecutionResult {
	const name = boundedName(call.name);
	return {
		callId: call.callId,
		toolName: name,
		success: false,
		modelOutput: `${name} failed\nError kind: ${errorKind}\nError: ${message}`,
		summary: `${name} failed`,
		errorKind,
		metadata: {},
	};
}

function boundedName(value: string): string {
	return value.slice(0, 128) || "Tool";
}
