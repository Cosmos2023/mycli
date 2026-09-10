import type { ToolDefinition } from "@mycli/core";
import { ASK_USER_QUESTION_TOOL_DEFINITION } from "./manifest.ts";
import { REQUEST_PERMISSIONS_TOOL_NAME } from "../policy/permission-grants.ts";
import type { BuiltInToolManifest } from "../types.ts";

export interface ToolExposureCapabilities {
	readonly shell: boolean;
	readonly requestPermissionsTool?: boolean;
	readonly collaborationMode?: string;
}

export function planToolExposure(
	manifest: BuiltInToolManifest,
	capabilities: ToolExposureCapabilities = { shell: false },
): readonly ToolDefinition[] {
	return Object.freeze(manifest.tools
		.filter((tool) => tool.model_visible
			&& (!tool.effects.process || capabilities.shell)
			&& (tool.name !== ASK_USER_QUESTION_TOOL_DEFINITION.name
				|| capabilities.collaborationMode === "plan")
			&& (tool.name !== REQUEST_PERMISSIONS_TOOL_NAME
				|| capabilities.requestPermissionsTool === true))
		.map((tool) => Object.freeze({
		id: tool.id,
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
	})));
}
