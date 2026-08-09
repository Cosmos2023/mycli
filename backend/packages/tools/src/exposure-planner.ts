import type { ToolDefinition } from "@mycli/core";
import type { BuiltInToolManifest } from "./types.ts";

export interface ToolExposureCapabilities {
	readonly shell: boolean;
}

export function planToolExposure(
	manifest: BuiltInToolManifest,
	capabilities: ToolExposureCapabilities = { shell: false },
): readonly ToolDefinition[] {
	return Object.freeze(manifest.tools
		.filter((tool) => tool.model_visible && (!tool.effects.process || capabilities.shell))
		.map((tool) => Object.freeze({
		id: tool.id,
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
	})));
}
