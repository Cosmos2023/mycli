import type { ToolDefinition } from "@mycli/core";
import type { BuiltInToolManifest } from "./types.ts";

export function planToolExposure(manifest: BuiltInToolManifest): readonly ToolDefinition[] {
	return Object.freeze(manifest.tools.map((tool) => Object.freeze({
		id: tool.id,
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
	})));
}
