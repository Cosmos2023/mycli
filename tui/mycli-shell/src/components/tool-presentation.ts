import type { MycliShellTool, MycliShellToolStatus } from "../model.ts";
import { canonicalToolName, shortPreview } from "./tool-display.ts";

export type ToolPresentation = {
	label: string;
	icon: string;
	accent: "accent" | "warning" | "error" | "bashMode" | "muted";
	previewLines: number;
	writePreviewLines: number;
	terminalPreviewLines: number;
	alwaysShowDetails?: boolean;
};

const DEFAULT_PRESENTATION: ToolPresentation = {
	label: "Tool",
	icon: "⏺",
	accent: "accent",
	previewLines: 12,
	writePreviewLines: 10,
	terminalPreviewLines: 12,
};

const TOOL_PRESENTATIONS: Record<string, Partial<ToolPresentation>> = {
	bash: { label: "Bash", accent: "bashMode", terminalPreviewLines: 5, alwaysShowDetails: true },
	shell: { label: "Shell", accent: "bashMode", terminalPreviewLines: 5, alwaysShowDetails: true },
	run_shell: { label: "Shell", accent: "bashMode", terminalPreviewLines: 5, alwaysShowDetails: true },
	write: { label: "Write", accent: "warning", writePreviewLines: 10 },
	write_file: { label: "Write", accent: "warning", writePreviewLines: 10 },
	edit: { label: "Edit", accent: "warning", previewLines: 14 },
	edit_file: { label: "Edit", accent: "warning", previewLines: 14 },
	patch: { label: "Patch", accent: "warning", previewLines: 14 },
	patch_file: { label: "Patch", accent: "warning", previewLines: 14 },
	read: { label: "Read", previewLines: 8 },
	grep: { label: "Grep", previewLines: 8 },
	glob: { label: "Glob", previewLines: 8 },
	ls: { label: "LS", previewLines: 8 },
	compact: { label: "Compact", previewLines: 6 },
};

export function presentationForTool(name: string, status?: MycliShellToolStatus, mutating?: boolean): ToolPresentation {
	const base = { ...DEFAULT_PRESENTATION, label: canonicalToolName(name) };
	const keyed = TOOL_PRESENTATIONS[name.trim().toLowerCase()] ?? {};
	const presentation = { ...base, ...keyed };
	if (status === "error") {
		return { ...presentation, accent: "error" };
	}
	if (mutating && presentation.accent === "accent") {
		return { ...presentation, accent: "warning" };
	}
	return presentation;
}

export function presentationForBash(): ToolPresentation {
	return presentationForTool("bash");
}

export function conciseToolResult(tool: MycliShellTool): string {
	const target = shortPreview(tool.args);
	if (tool.status === "running") {
		return target ? `${target} · Running...` : "Running...";
	}
	if (tool.status === "cancelled") {
		return target ? `${target} · Cancelled` : "Cancelled";
	}
	if (tool.status === "error") {
		const failure = firstMeaningfulLine(tool.errorPreview ?? tool.outputPreview) ?? "Failed";
		return target ? `${target} · ${failure}` : failure;
	}
	if (tool.contentPreview) {
		const lineCount = tool.contentLineCount;
		const summary = lineCount !== undefined ? `Wrote ${lineCount} ${lineCount === 1 ? "line" : "lines"}` : "Wrote file";
		return target ? `${target} · ${summary}` : summary;
	}
	if (tool.diffPreview) {
		return target ? `Updated ${target}` : "Updated file";
	}
	const summary = firstMeaningfulLine(tool.outputPreview) ?? statusLabel(tool);
	if (target && summary !== target) {
		return `${target} · ${summary}`;
	}
	return summary;
}

export function firstMeaningfulLine(text: string | undefined): string | undefined {
	return text
		?.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
}

function statusLabel(tool: MycliShellTool): string {
	switch (tool.status) {
		case "running":
			return "running";
		case "success":
			return tool.mutating ? "changed" : "done";
		case "error":
			return "failed";
		case "cancelled":
			return "cancelled";
	}
}
