import { randomUUID } from "node:crypto";
import { ElicitRequestParamsSchema, type ElicitRequestParams, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { parseGatewayEvent, type McpElicitationField, type McpElicitationRequest } from "@mycli/contracts";
import { createToolSchemaValidator } from "@mycli/tools";
import { waitForMcpOperation } from "./shared-operation.ts";

export interface McpInvocationContext {
	readonly sessionId: string;
	readonly turnId?: string;
	readonly pauseTimeout?: () => () => void;
}

export interface McpElicitationPrompt {
	readonly request: McpElicitationRequest;
	validate(result: ElicitResult): boolean;
}

export type McpElicitationHandler = (prompt: McpElicitationPrompt, signal: AbortSignal) => Promise<ElicitResult>;

/** Each protocol generation admits requests only while a unique session/turn owns active calls. */
export class McpElicitationCoordinator {
	readonly #active = new Map<symbol, { readonly context: McpInvocationContext; readonly signal: AbortSignal }>();
	readonly #pending = new Map<symbol, { readonly owner: string; readonly controller: AbortController }>();
	constructor(readonly serverId: string, readonly handler: McpElicitationHandler) {}

	enter(context: McpInvocationContext | undefined, signal: AbortSignal): () => void {
		if (!context) return () => undefined;
		const id = Symbol();
		this.#active.set(id, { context, signal });
		const leave = (): void => {
			this.#active.delete(id);
			signal.removeEventListener("abort", leave);
			this.#cancelUnowned();
		};
		signal.addEventListener("abort", leave, { once: true });
		if (signal.aborted) leave();
		return leave;
	}

	async request(params: ElicitRequestParams, signal: AbortSignal): Promise<ElicitResult> {
		const active = [...this.#active.values()].filter((entry) => !entry.signal.aborted);
		if (!active.length || new Set(active.map((entry) => ownerKey(entry.context))).size !== 1 || this.#pending.size >= 16) return { action: "cancel" };
		const owner = active[0]!.context;
		let prompt: McpElicitationPrompt;
		try { prompt = mcpElicitationPrompt(this.serverId, owner, params); }
		catch { return { action: "decline" }; }
		const controller = new AbortController();
		const id = Symbol();
		this.#pending.set(id, { owner: ownerKey(owner), controller });
		const resume = active.map((entry) => entry.context.pauseTimeout?.());
		const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(300_000)]);
		try {
			combined.throwIfAborted();
			const result = await waitForMcpOperation(this.handler(prompt, combined), combined);
			return combined.aborted ? { action: "cancel" } : prompt.validate(result) ? result : { action: "decline" };
		} catch { return { action: "cancel" }; }
		finally { this.#pending.delete(id); resume.forEach((release) => release?.()); }
	}

	close(): void {
		for (const { controller } of this.#pending.values()) controller.abort();
		this.#active.clear();
	}

	#cancelUnowned(): void {
		const owners = new Set([...this.#active.values()].map((entry) => ownerKey(entry.context)));
		for (const pending of this.#pending.values()) if (!owners.has(pending.owner)) pending.controller.abort();
	}
}

function ownerKey(owner: McpInvocationContext): string { return JSON.stringify([owner.sessionId, owner.turnId]); }

export function mcpElicitationPrompt(serverId: string, owner: McpInvocationContext, raw: unknown): McpElicitationPrompt {
	if (Buffer.byteLength(JSON.stringify(raw)) > 65_536) throw new Error("invalid_mcp_elicitation");
	const params = ElicitRequestParamsSchema.parse(raw);
	if (params.task) throw new Error("invalid_mcp_elicitation");
	const identity = { request_id: randomUUID(), session_id: owner.sessionId,
		...(owner.turnId ? { turn_id: owner.turnId } : {}), server_id: serverId, message: params.message };
	if (params.mode === "url") {
		const url = new URL(params.url);
		if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
			|| url.username || url.password) throw new Error("invalid_mcp_elicitation");
		const request: McpElicitationRequest = { ...identity, mode: "url", url: url.toString(), fields: [] };
		validateRequest(request);
		return { request, validate: (result) => validAction(result) && result.content === undefined };
	}
	const properties = params.requestedSchema.properties;
	const required = new Set(params.requestedSchema.required ?? []);
	if ([...required].some((name) => !Object.hasOwn(properties, name))) throw new Error("invalid_mcp_elicitation");
	const fields = Object.entries(properties).map(([name, schema]): McpElicitationField => {
		if (["__proto__", "prototype", "constructor"].includes(name)) throw new Error("invalid_mcp_elicitation");
		const descriptor = schema as Record<string, unknown>;
		const choices = schema.type === "array" ? descriptor.items as Record<string, unknown> : descriptor;
		const enums = choices.enum as string[] | undefined;
		const titled = (choices.oneOf ?? choices.anyOf) as { const: string; title: string }[] | undefined;
		const options = enums?.map((value, index) => ({ value, label: (descriptor.enumNames as string[] | undefined)?.[index] ?? value }))
			?? titled?.map((entry) => ({ value: entry.const, label: entry.title }));
		return { name, label: schema.title || name, type: schema.type, required: required.has(name),
			...(schema.description ? { description: schema.description } : {}), ...(options ? { options } : {}),
			...(schema.default === undefined ? {} : { defaultValue: schema.default }),
			...Object.fromEntries(["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "format"]
				.flatMap((key) => descriptor[key] === undefined ? [] : [[key, descriptor[key]]])) };
	});
	const request: McpElicitationRequest = { ...identity, mode: "form", fields };
	validateRequest(request);
	const schema = { ...params.requestedSchema, additionalProperties: false,
		properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key,
			Object.fromEntries(Object.entries(value).filter(([name]) => name !== "enumNames"))])) };
	const validate = createToolSchemaValidator().compile(schema);
	return { request, validate: (result) => validAction(result) && (result.action !== "accept"
		? result.content === undefined : result.content !== undefined && Buffer.byteLength(JSON.stringify(result.content)) <= 32_768 && validate(result.content)) };
}

function validAction(result: ElicitResult): boolean { return ["accept", "decline", "cancel"].includes(result.action); }
function validateRequest(request: McpElicitationRequest): void {
	parseGatewayEvent({ jsonrpc: "2.0", method: "mcp.elicitation.request", params: request });
}
