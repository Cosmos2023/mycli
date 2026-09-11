import { catalogNames } from "./integration-resource-catalog.ts";
import type { ResolvedSlashCommand } from "./node-slash-command-registry.ts";
import { errorCommandResult, listCommandResult } from "./node-slash-command-results.ts";

type JsonObject = Record<string, unknown>;

export function integrationInspectionResult(
	invocation: ResolvedSlashCommand,
	input: { readonly resources: readonly JsonObject[]; readonly manifest?: JsonObject },
): JsonObject {
	if (invocation.commandId === "tools") return toolInventory(invocation, input.manifest);
	if (invocation.commandId === "mcp" && invocation.args && invocation.args !== "verbose") {
		return errorCommandResult(invocation, "Unsupported MCP action", "/mcp [verbose]");
	}
	const kind = invocation.commandId === "skills" ? "skill"
		: invocation.commandId === "plugins" ? "plugin" : invocation.commandId === "hooks" ? "hook" : "mcp";
	const title = kind === "mcp" ? "MCP servers" : kind === "plugin" ? "Plugins" : kind === "hook" ? "Hooks" : "Skills";
	const resources = input.resources.filter((resource) => resource.type === kind);
	return listCommandResult(invocation, title, resources.map((resource, index) => ({
		key: String(resource.id ?? `${kind}:${index}`),
		label: String(resource.name ?? resource.id ?? title),
		values: kind === "mcp" ? [`${count(resource.tool_count)} tools`, `${count(resource.resource_count)} resources`]
			: [String(resource.source ?? "runtime")],
		status: String(resource.status ?? (resource.enabled === false ? "disabled" : "configured")),
		detail: kind === "mcp" ? mcpDetail(resource, invocation.args === "verbose")
			: text(resource.inspection_detail) ?? text(resource.detail),
	})));
}

function toolInventory(invocation: ResolvedSlashCommand, manifest?: JsonObject): JsonObject {
	if (invocation.args === "sets") {
		return listCommandResult(invocation, "Tool sets", records(manifest?.toolsets).map((value, index) => ({
			key: `toolset:${index}`, label: String(value.id ?? "Tool set"),
			values: [`tools=${count(value.tool_count)}`],
		})));
	}
	if (invocation.args && invocation.args !== "list") {
		return errorCommandResult(invocation, "Unsupported tools action", "/tools [list|sets]");
	}
	return listCommandResult(invocation, "Tools", records(manifest?.tools).map((value, index) => ({
		key: String(value.id ?? `tool:${index}`), label: String(value.name ?? value.id ?? "Tool"),
		values: [String(value.source ?? "runtime"), String(value.toolset ?? "")].filter(Boolean),
		...(isObject(value.availability) && typeof value.availability.status === "string"
			? { status: value.availability.status } : {}),
		detail: text(value.description),
	})));
}

function mcpDetail(resource: JsonObject, verbose: boolean): string {
	const names = Array.isArray(resource.tool_names) ? resource.tool_names.filter((name): name is string => typeof name === "string") : [];
	return [
		text(resource.detail),
		`Tools: ${catalogNames(names, count(resource.tool_count))}`,
		...(verbose ? [text(resource.inspection_detail)] : []),
	].filter(Boolean).join("\n");
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function records(value: unknown): JsonObject[] {
	return Array.isArray(value) ? value.filter(isObject) : [];
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
