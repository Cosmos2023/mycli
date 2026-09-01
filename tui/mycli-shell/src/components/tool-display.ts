import { sliceByColumn, visibleWidth } from "../tui-core/utils.ts";
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

export function compactPathPreview(text: string | undefined, maxWidth: number): string | undefined {
	const sanitized = text ? sanitizeInline(text) : "";
	if (!sanitized || maxWidth <= 0) return undefined;
	if (visibleWidth(sanitized) <= maxWidth) return sanitized;
	const ellipsis = uiGlyphs().ellipsis;
	const ellipsisWidth = visibleWidth(ellipsis);
	if (maxWidth <= ellipsisWidth) return sliceByColumn(ellipsis, 0, maxWidth);

	const separator = sanitized.includes("\\") && !sanitized.includes("/") ? "\\" : "/";
	const parts = sanitized.split(/[\\/]/u).filter(Boolean);
	const leaf = parts.at(-1) ?? sanitized;
	let prefix = ellipsis;
	if (parts.length > 1) {
		if (sanitized.startsWith(`~${separator}`)) {
			prefix = `~${separator}${ellipsis}${separator}`;
		} else if (sanitized.startsWith(separator)) {
			prefix = `${separator}${ellipsis}${separator}`;
		} else if (/^[A-Za-z]:[\\/]/u.test(sanitized)) {
			prefix = `${sanitized.slice(0, 2)}${separator}${ellipsis}${separator}`;
		} else {
			prefix = `${parts[0]}${separator}${ellipsis}${separator}`;
		}
	}

	if (visibleWidth(`${prefix}${leaf}`) <= maxWidth) return `${prefix}${leaf}`;
	const suffixWidth = maxWidth - ellipsisWidth;
	const leafWidth = visibleWidth(leaf);
	return `${ellipsis}${sliceByColumn(leaf, Math.max(0, leafWidth - suffixWidth), suffixWidth)}`;
}

export function isReadToolName(name: string): boolean {
	const lower = name.trim().toLowerCase();
	return lower === "read" || lower === "read_file";
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
