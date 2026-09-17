import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MycliShellFooterData } from "../../model.ts";
import { theme } from "../../theme/theme.ts";
import type { Component } from "../../tui-core/tui.ts";
import { truncateToWidth, visibleWidth } from "../../tui-core/utils.ts";
import { alignStatusColumns, insetStatusLine, joinStatusParts, sanitizeStatusText, statusLineWidth } from "./status-line.ts";

export type FooterOptions = {
	statusbarMode?: "off" | "compact" | "full";
};

function formatCwdForFooter(cwd: string, home: string | undefined = process.env.HOME || process.env.USERPROFILE): string {
	if (cwd === "~" || cwd.startsWith("~/") || cwd.startsWith("~\\")) return cwd;
	if (!home) return cwd;
	const relativeToHome = relative(resolve(home), resolve(cwd));
	const insideHome = relativeToHome === "" || (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!insideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function compactPathToWidth(path: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(path) <= width) return path;
	const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
	const leaf = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
	let prefix = `...${separator}`;
	if (path.startsWith(`~${separator}`)) prefix = `~${separator}...${separator}`;
	else if (path.startsWith(separator)) prefix = `${separator}...${separator}`;
	else if (/^[A-Za-z]:[\\/]/.test(path)) prefix = `${path.slice(0, 2)}${separator}...${separator}`;
	return truncateToWidth(`${prefix}${leaf}`, width, "...");
}

/** Stable session context only. Live work belongs above the composer. */
export class FooterComponent implements Component {
	constructor(
		private readonly data: MycliShellFooterData,
		private readonly options: FooterOptions = {},
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.data.transientHint) return [insetStatusLine(theme.fg("muted", sanitizeStatusText(this.data.transientHint)), width)];
		if (this.options.statusbarMode === "off") return [];
		const contentWidth = statusLineWidth(width);
		const model = this.modelRow(contentWidth);
		const rows = visibleWidth(model) > 0 ? [model] : [];
		if (this.options.statusbarMode !== "compact" || rows.length === 0) rows.push(this.workspaceRow(contentWidth));
		return rows.map((row) => insetStatusLine(row, width));
	}

	private modelRow(width: number): string {
		const badges: string[] = [];
		const trust = sanitizeStatusText(this.data.trust ?? "").toLowerCase();
		if (trust && trust !== "trusted") badges.push(theme.fg("warning", trust === "unknown" ? "trust?" : `trust ${trust}`));
		if (this.data.collaborationMode === "plan") badges.push(theme.fg("accent", "plan"));
		const prefix = joinStatusParts(badges);
		const model = theme.fg("muted", sanitizeStatusText(this.data.model ?? ""));
		const reasoning = theme.fg("dim", sanitizeStatusText(this.data.reasoningLevel ?? ""));
		let context = this.contextUsage();
		// Preserve mode/trust before resource metadata in very narrow terminals.
		const minimumLeft = visibleWidth(prefix) > 0 ? visibleWidth(prefix) : Math.min(8, visibleWidth(model));
		if (minimumLeft + 2 + visibleWidth(context) > width) context = "";
		const leftWidth = context ? width - visibleWidth(context) - 2 : width;
		let left = joinStatusParts([...badges, model, reasoning]);
		if (visibleWidth(left) > leftWidth) left = joinStatusParts([...badges, model]);
		return alignStatusColumns(left, context, width);
	}

	private workspaceRow(width: number): string {
		const path = sanitizeStatusText(formatCwdForFooter(this.data.cwd));
		const session = truncateToWidth(sanitizeStatusText(this.data.sessionName ?? ""), Math.floor(width * 0.4), "...");
		const leftWidth = session ? width - visibleWidth(session) - 2 : width;
		const branch = this.data.gitBranch ? ` (${sanitizeStatusText(this.data.gitBranch)})` : "";
		const left = visibleWidth(path + branch) <= leftWidth ? path + branch : compactPathToWidth(path, leftWidth);
		return theme.fg("dim", alignStatusColumns(left, session, width));
	}

	private contextUsage(): string {
		const value = this.data.contextPercent;
		if (value === undefined) return "";
		const percent = value.toFixed(Number.isInteger(value) ? 0 : 1);
		const prefix = this.data.contextSource === "runtime_estimate" ? "~" : "";
		const suffix = this.data.contextSource === "provider_previous" ? " prev" : "";
		return theme.fg(value > 90 ? "error" : value > 70 ? "warning" : "dim", `${prefix}${percent}% ctx${suffix}`);
	}
}
