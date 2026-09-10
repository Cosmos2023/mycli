import { uiGlyphs } from "../theme/terminal-style.ts";

export const TOOL_PREVIEW_CHARS = 72;

export function sanitizeInline(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export function shortPreview(text: string | undefined, maxChars = TOOL_PREVIEW_CHARS): string | undefined {
	const sanitized = text ? sanitizeInline(text) : "";
	if (!sanitized) {
		return undefined;
	}
	if (sanitized.length <= maxChars) {
		return sanitized;
	}
	const ellipsis = uiGlyphs().ellipsis;
	return `${sanitized.slice(0, Math.max(0, maxChars - ellipsis.length)).trimEnd()}${ellipsis}`;
}

export function isReadToolName(name: string): boolean {
	return contextToolKind(name) === "read";
}

export function contextToolKind(name: string): "read" | "search" | "glob" | "list" | undefined {
	const normalized = name.trim().toLowerCase().replace(/[_-]/gu, "");
	if (normalized === "read" || normalized === "readfile") return "read";
	if (normalized === "grep" || normalized === "search") return "search";
	if (normalized === "glob") return "glob";
	if (normalized === "ls" || normalized === "list") return "list";
	return undefined;
}

export function contextToolLabel(name: string, running = false): string | undefined {
	switch (contextToolKind(name)) {
		case "read": return running ? "Reading" : "Read";
		case "search": return running ? "Searching" : "Search";
		case "glob": return running ? "Finding" : "Find";
		case "list": return running ? "Listing" : "List";
		default: return undefined;
	}
}

export function canonicalToolName(name: string): string {
	const normalized = name.trim();
	const lower = normalized.toLowerCase();
	if (isReadToolName(lower)) return "Read";
	if (lower === "write" || lower === "write_file") return "Write";
	if (lower === "edit" || lower === "edit_file") return "Edit";
	if (lower === "patch" || lower === "patch_file") return "Patch";
	if (lower === "bash") return "Bash";
	if (lower === "shell" || lower === "run_shell") return "Shell";
	return normalized || "Tool";
}
