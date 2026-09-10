import { posix, win32 } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { MycliShellBash, MycliShellTool, MycliShellToolStatus } from "../model.ts";
import { cachedShellSearchPreview, shellSearchHasNoMatches } from "./shell-search-preview.ts";
import { contextToolKind, sanitizeInline } from "./tool-display.ts";

export interface ContextActivity {
	readonly kind: "read" | "search" | "list" | "tool";
	readonly label: string;
	readonly targets: readonly string[];
	readonly scope?: string;
	readonly status: MycliShellToolStatus;
}

export function toolContextActivity(tool: MycliShellTool): ContextActivity | undefined {
	if (tool.mutating || tool.terminalInteraction) return undefined;
	const kind = contextToolKind(tool.name);
	if (!kind && tool.presentation !== "context") return undefined;
	const target = tool.args === `Executing ${tool.name}` ? "" : inline(tool.args ?? "");
	if (kind === "read") {
		const path = target.includes("\\") ? win32 : posix;
		return { kind, label: "Read", targets: [path.basename(target) || "file"], status: tool.status };
	}
	if (kind === "search" || kind === "glob") {
		return { kind: "search", label: "Search", targets: [target], status: tool.status };
	}
	if (kind === "list") return { kind, label: "List", targets: [target || ".."], status: tool.status };
	return { kind: "tool", label: inline(tool.name), targets: [target], status: tool.status };
}

export function shellContextActivity(shell: MycliShellBash): ContextActivity | undefined {
	const search = cachedShellSearchPreview(shell);
	if (!search) return undefined;
	const paths = search.paths.map(inline);
	return {
		kind: search.kind,
		label: search.kind === "list" ? "List" : "Search",
		targets: search.kind === "list" ? paths.length ? paths : [".."] : search.queries.map((query) => inline(query) || '""'),
		...(search.kind === "search" && paths.length ? { scope: paths.join(", ") } : {}),
		status: shellSearchHasNoMatches(shell, search) ? "success" : shell.status,
	};
}

function inline(text: string): string {
	return sanitizeInline(stripVTControlCharacters(text));
}
