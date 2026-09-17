import { parseExtensionApprovalScope } from "@mycli/core";
import type { ExtensionApprovalScope, ToolDefinition } from "@mycli/core";
import type { ExtensionToolApprovalPolicy, ToolAdapter } from "@mycli/tools";
import {
	createToolSchemaValidator,
	EXTENSION_ORIGIN_MAX_ENTRIES,
	EXTENSION_ORIGIN_MAX_KEY_LENGTH,
	EXTENSION_ORIGIN_MAX_VALUE_LENGTH,
} from "@mycli/tools";
import {
	INTEGRATION_ID_MAX_LENGTH,
	type IntegrationSource,
	PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH,
} from "./ids.ts";

export interface IntegrationRegistration {
	readonly id: string;
	readonly source: IntegrationSource;
	readonly definition: ToolDefinition;
	readonly adapter: ToolAdapter;
	readonly originMetadata: Readonly<Record<string, string>>;
	readonly sourceDescription?: string;
	readonly supportsParallelToolCalls: boolean;
	readonly modelVisible?: boolean;
	readonly approvalPolicy?: ExtensionToolApprovalPolicy["approvalPolicy"];
	readonly approvalScope?: ExtensionApprovalScope;
}

const PROVIDER_SAFE_NAME = /^[A-Za-z0-9_]+$/;
const SAFE_ORIGIN_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SENSITIVE_ORIGIN_KEY = /(?:authorization|cookie|key|password|secret|token)/iu;

export function defineIntegrationRegistration(
	input: Omit<IntegrationRegistration, "supportsParallelToolCalls">,
): IntegrationRegistration {
	if (!input.id || input.id.length > INTEGRATION_ID_MAX_LENGTH) {
		throw new Error("invalid_integration_id");
	}
	if (input.definition.id !== input.id || input.adapter.definition.id !== input.id) {
		throw new Error("integration_definition_mismatch");
	}
	if (input.definition.name !== input.adapter.definition.name) {
		throw new Error("integration_route_mismatch");
	}
	if (!PROVIDER_SAFE_NAME.test(input.definition.name)
		|| input.definition.name.length > PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH) {
		throw new Error("invalid_integration_route");
	}
	if (input.approvalPolicy !== undefined && !["auto_allow", "request", "always_request"].includes(input.approvalPolicy)
		|| input.approvalScope !== undefined && (!parseExtensionApprovalScope(input.approvalScope) || input.approvalScope.id !== input.id)) {
		throw new Error("invalid_integration_approval_policy");
	}
	const originEntries = Object.entries(input.originMetadata);
	if (originEntries.length > EXTENSION_ORIGIN_MAX_ENTRIES) {
		throw new Error("integration_origin_too_large");
	}
	for (const [key, value] of originEntries) {
		if (!SAFE_ORIGIN_KEY.test(key)
			|| key.length > EXTENSION_ORIGIN_MAX_KEY_LENGTH
			|| SENSITIVE_ORIGIN_KEY.test(key)
			|| !value
			|| value.length > EXTENSION_ORIGIN_MAX_VALUE_LENGTH) {
			throw new Error("invalid_integration_origin");
		}
	}
	const definition = freezeDefinition(input.definition);
	try {
		createToolSchemaValidator().compile(definition.inputSchema);
	} catch {
		throw new Error("invalid_integration_tool_schema");
	}
	return Object.freeze({
		id: input.id,
		source: input.source,
		definition,
		adapter: input.adapter,
		originMetadata: Object.freeze(Object.fromEntries(originEntries)),
		...(input.sourceDescription === undefined ? {} : { sourceDescription: input.sourceDescription }),
		supportsParallelToolCalls: input.adapter.supportsParallelToolCalls === true,
		modelVisible: input.modelVisible ?? true,
		...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
		...(input.approvalScope ? { approvalScope: Object.freeze({ ...input.approvalScope }) } : {}),
	});
}

function freezeDefinition(definition: ToolDefinition): ToolDefinition {
	return Object.freeze({
		...definition,
		inputSchema: deepFreezeCopy(definition.inputSchema),
	});
}

function deepFreezeCopy<Value>(value: Value): Value {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((item) => deepFreezeCopy(item))) as Value;
	}
	if (typeof value !== "object" || value === null) return value;
	return Object.freeze(Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, deepFreezeCopy(item)]),
	)) as Value;
}
