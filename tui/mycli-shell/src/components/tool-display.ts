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
	return `${sanitized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function canonicalToolName(name: string): string {
	const normalized = name.trim();
	const lower = normalized.toLowerCase();
	if (lower === "write" || lower === "write_file") return "Write";
	if (lower === "edit" || lower === "edit_file") return "Edit";
	if (lower === "patch" || lower === "patch_file") return "Patch";
	if (lower === "bash") return "Bash";
	if (lower === "shell" || lower === "run_shell") return "Shell";
	return normalized || "Tool";
}
