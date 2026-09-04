import type {
	CanonicalToolCall,
	FileMutationPreviewChange,
	ToolDefinition,
} from "@mycli/core";
import { stableModelInputJson, TOOL_RESULT_OUTPUT_MAX_CHARS } from "@mycli/core";
import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
	ToolAdapter,
	ToolExecutionOptions,
	PreparedToolCall,
	ToolPreviewOptions,
	ToolExecutionResult,
	ToolRouterContract,
	ToolTurnCatalog,
} from "./types.ts";

export interface ToolRouterOptions {
	readonly adapters: readonly ToolAdapter[];
	readonly exposure: readonly ToolDefinition[];
}

interface Route {
	readonly adapter: ToolAdapter;
	readonly validate: ValidateFunction;
}

export class ToolRouter implements ToolRouterContract {
	readonly #ajv = new Ajv2020({ allErrors: true, strict: true });
	readonly #staticRoutes: ReadonlyMap<string, Route>;
	#routes: ReadonlyMap<string, Route>;
	#dynamicRoutes: ReadonlyMap<string, Route> = new Map();
	readonly #turnRoutes = new Map<string, ReadonlyMap<string, Route>>();
	readonly #turnDynamicRoutes = new Map<string, ReadonlyMap<string, Route>>();

	constructor(options: ToolRouterOptions) {
		this.#staticRoutes = this.#compileRoutes(options.adapters);
		this.#routes = this.#staticRoutes;
	}

	beginTurn(turnId: string, catalog?: ToolTurnCatalog): void {
		if (this.#turnRoutes.has(turnId)) return;
		const dynamicRoutes = catalog
			? matchingDynamicRoutes(this.#dynamicRoutes, catalog.deferredTools)
			: this.#dynamicRoutes;
		const routes = new Map([...this.#staticRoutes, ...dynamicRoutes]);
		this.#turnRoutes.set(turnId, routes);
		this.#turnDynamicRoutes.set(turnId, dynamicRoutes);
		for (const adapter of uniqueAdapters(routes)) adapter.beginTurn?.(turnId, catalog);
	}

	finishTurn(turnId: string): void {
		const routes = this.#turnRoutes.get(turnId);
		if (!routes) return;
		this.#turnRoutes.delete(turnId);
		this.#turnDynamicRoutes.delete(turnId);
		for (const adapter of uniqueAdapters(routes)) adapter.finishTurn?.(turnId);
	}

	replaceDynamicAdapters(adapters: readonly ToolAdapter[]): void {
		const dynamic = this.#compileRoutes(adapters, this.#staticRoutes);
		this.#dynamicRoutes = dynamic;
		this.#routes = new Map([...this.#staticRoutes, ...dynamic]);
	}

	dynamicDefinitions(turnId?: string): readonly ToolDefinition[] {
		const routes = turnId
			? this.#turnDynamicRoutes.get(turnId) ?? this.#dynamicRoutes
			: this.#dynamicRoutes;
		return Object.freeze([...routes.values()].map((route) => route.adapter.definition));
	}

	supportsParallelToolCalls(call: CanonicalToolCall, turnId?: string): boolean {
		return this.#routesFor(turnId).get(call.name)?.adapter.supportsParallelToolCalls === true;
	}

	async prepare(
		call: CanonicalToolCall,
		options: ToolPreviewOptions,
	): Promise<PreparedToolCall> {
		const route = this.#routesFor(options.ownerTurnId).get(call.name);
		if (!route) return EMPTY_PREPARATION;
		const argumentsValue = parseArguments(call.argumentsJson);
		if (!argumentsValue || !route.validate(argumentsValue)) return EMPTY_PREPARATION;
		try {
			if (route.adapter.prepare) return await route.adapter.prepare(argumentsValue, options);
			if (route.adapter.preview) {
				return Object.freeze({
					fileChanges: await route.adapter.preview(argumentsValue, options),
				});
			}
			return EMPTY_PREPARATION;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw error;
			return EMPTY_PREPARATION;
		}
	}

	async preview(
		call: CanonicalToolCall,
		options: ToolPreviewOptions,
	): Promise<readonly FileMutationPreviewChange[]> {
		return (await this.prepare(call, options)).fileChanges;
	}

	async execute(
		call: CanonicalToolCall,
		options: ToolExecutionOptions,
	): Promise<ToolExecutionResult> {
		const route = this.#routesFor(options.ownerTurnId).get(call.name);
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

	#routesFor(turnId: string | undefined): ReadonlyMap<string, Route> {
		return turnId ? this.#turnRoutes.get(turnId) ?? this.#routes : this.#routes;
	}

	#compileRoutes(
		adapters: readonly ToolAdapter[],
		reserved: ReadonlyMap<string, Route> = new Map(),
	): ReadonlyMap<string, Route> {
		const routes = new Map<string, Route>();
		for (const adapter of adapters) {
			const name = adapter.definition.name;
			if (reserved.has(name) || routes.has(name)) {
				throw new Error(`duplicate_tool: ${boundedName(name)}`);
			}
			routes.set(name, {
				adapter,
				validate: this.#ajv.compile(adapter.definition.inputSchema),
			});
		}
		return routes;
	}
}

const EMPTY_PREPARATION: PreparedToolCall = Object.freeze({
	fileChanges: Object.freeze([]),
});

function uniqueAdapters(routes: ReadonlyMap<string, Route>): readonly ToolAdapter[] {
	return [...new Set([...routes.values()].map((route) => route.adapter))];
}

function matchingDynamicRoutes(
	routes: ReadonlyMap<string, Route>,
	definitions: readonly ToolDefinition[],
): ReadonlyMap<string, Route> {
	const expected = new Map(definitions.map((definition) => [
		definition.name,
		stableModelInputJson(definition),
	]));
	return new Map([...routes].filter(([name, route]) => (
		expected.get(name) === stableModelInputJson(route.adapter.definition)
	)));
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
