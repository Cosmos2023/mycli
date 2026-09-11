import type { MycliShellBash, MycliShellTool } from "../model.ts";

export type CollapsedToolGroupItem =
	| { kind: "tool"; tool: MycliShellTool }
	| { kind: "bash"; bash: MycliShellBash };

export type CollapsedToolGroup = {
	id: string;
	items: CollapsedToolGroupItem[];
};
