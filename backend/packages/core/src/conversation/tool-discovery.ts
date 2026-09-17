import { modelInputSha256 } from "./model-input.ts";
import type { ToolDefinition } from "../types.ts";

export interface ToolDiscovery {
	readonly id: string;
	readonly name: string;
	readonly definitionSha256: string;
}

export function toolDiscovery(definition: ToolDefinition): ToolDiscovery {
	return Object.freeze({ id: definition.id, name: definition.name, definitionSha256: modelInputSha256(definition) });
}

export function parseToolDiscoveries(value: unknown): readonly ToolDiscovery[] {
	if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1
		|| !("tools" in value) || !Array.isArray(value.tools) || value.tools.length > 16) return [];
	const tools: ToolDiscovery[] = [];
	for (const entry of value.tools) {
		if (typeof entry !== "object" || entry === null
			|| typeof entry.id !== "string" || entry.id.length > 128 || !/^(mcp|plugin):[A-Za-z0-9._:-]+$/u.test(entry.id)
			|| typeof entry.name !== "string" || !/^[A-Za-z0-9_]{1,64}$/u.test(entry.name)
			|| typeof entry.definitionSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.definitionSha256)) return [];
		tools.push(Object.freeze({ id: entry.id, name: entry.name, definitionSha256: entry.definitionSha256 }));
	}
	return Object.freeze(tools);
}
