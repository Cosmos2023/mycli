import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Component } from "../tui-core/tui.ts";
import { truncateToWidth, visibleWidth } from "../tui-core/utils.ts";
import type { MycliShellFooterData } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { rawKeyHint } from "./keybinding-hints.ts";

export type FooterInteractionState = {
	turnRunning: boolean;
	hasQueuedInput: boolean;
};

type FooterSegment = {
	id: string;
	text: string;
	optional: boolean;
};

const idleInteraction: FooterInteractionState = {
	turnRunning: false,
	hasQueuedInput: false,
};

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatCwdForFooter(cwd: string, home: string | undefined = process.env.HOME || process.env.USERPROFILE): string {
	if (cwd === "~" || cwd.startsWith("~/") || cwd.startsWith("~\\")) return cwd;
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const insideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!insideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function compactPathToWidth(path: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(path) <= width) return path;

	const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
	const parts = path.split(/[\\/]/).filter(Boolean);
	const leaf = parts.at(-1) ?? path;
	let prefix = `...${separator}`;
	if (path.startsWith(`~${separator}`)) {
		prefix = `~${separator}...${separator}`;
	} else if (path.startsWith(separator)) {
		prefix = `${separator}...${separator}`;
	} else if (/^[A-Za-z]:[\\/]/.test(path)) {
		prefix = `${path.slice(0, 2)}${separator}...${separator}`;
	}

	return truncateToWidth(`${prefix}${leaf}`, width, "...");
}

function alignedColumns(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width, "...");
	if (!left) return truncateToWidth(right, width, "...");
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + 2 + rightWidth <= width) {
		return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
	}
	const availableRight = width - leftWidth - 2;
	if (availableRight >= 4) {
		const fittedRight = truncateToWidth(right, availableRight, "...");
		return `${left}${" ".repeat(Math.max(2, width - leftWidth - visibleWidth(fittedRight)))}${fittedRight}`;
	}
	return truncateToWidth(left, width, "...");
}

export class FooterComponent implements Component {
	constructor(
		private readonly data: MycliShellFooterData,
		private readonly interaction: FooterInteractionState = idleInteraction,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = [
			theme.fg("dim", this.contextRow(safeWidth)),
			theme.fg("dim", this.actionStatusRow(safeWidth)),
		];
		for (const status of this.data.extensionStatuses ?? []) {
			lines.push(truncateToWidth(theme.fg("dim", sanitizeStatusText(status)), safeWidth, theme.fg("dim", "...")));
		}
		return lines;
	}

	private contextRow(width: number): string {
		const path = sanitizeStatusText(formatCwdForFooter(this.data.cwd));
		const session = this.data.sessionName ? `• ${sanitizeStatusText(this.data.sessionName)}` : "";
		const branch = this.data.gitBranch ? `(${sanitizeStatusText(this.data.gitBranch)})` : "";
		const separator = path && session ? "  " : "";
		const fullLeft = `${path}${separator}${session}`;

		if (branch && visibleWidth(fullLeft) + 2 + visibleWidth(branch) <= width) {
			return alignedColumns(fullLeft, branch, width);
		}
		if (visibleWidth(fullLeft) <= width) {
			return fullLeft;
		}
		if (!session) {
			return compactPathToWidth(path, width);
		}

		const pathBudget = width - visibleWidth(session) - visibleWidth(separator);
		if (pathBudget >= 4) {
			return `${compactPathToWidth(path, pathBudget)}${separator}${session}`;
		}
		return truncateToWidth(session, width, "...");
	}

	private actionStatusRow(width: number): string {
		const actions = this.actionSegments();
		const statuses = this.statusSegments();
		const dropOrder = ["mode-cycle", "edit", "commands", "task", "reasoning", "model", "context", "follow-up"];

		for (const id of dropOrder) {
			if (this.segmentsFit(actions, statuses, width)) break;
			this.removeOptionalSegment(actions, id);
			this.removeOptionalSegment(statuses, id);
		}

		const left = actions.map((segment) => segment.text).join(theme.fg("muted", " · "));
		const right = statuses.map((segment) => segment.text).join(theme.fg("muted", " │ "));
		return alignedColumns(left, right, width);
	}

	private actionSegments(): FooterSegment[] {
		return [
			{ id: "enter", text: rawKeyHint("enter", this.interaction.turnRunning ? "steer" : "send"), optional: false },
			...(this.interaction.turnRunning
				? [
					{ id: "follow-up", text: rawKeyHint("tab", "follow-up"), optional: true },
					{ id: "interrupt", text: rawKeyHint("esc", "interrupt"), optional: false },
				]
				: [{ id: "commands", text: rawKeyHint("ctrl+p", "commands"), optional: true }]),
			...(this.interaction.hasQueuedInput
				? [{ id: "edit", text: rawKeyHint("alt+up", "edit follow-up"), optional: true }]
				: []),
		];
	}

	private statusSegments(): FooterSegment[] {
		const segments: FooterSegment[] = [];
		const trust = this.data.trust?.trim().toLowerCase();
		if (trust === "unknown") {
			segments.push({ id: "trust", text: theme.fg("warning", "trust?"), optional: false });
		} else if (trust && trust !== "trusted") {
			segments.push({ id: "trust", text: theme.fg("warning", `trust ${sanitizeStatusText(this.data.trust ?? trust)}`), optional: false });
		}
		if (this.data.collaborationMode === "plan") {
			segments.push({ id: "mode", text: theme.fg("accent", "plan"), optional: false });
			if (!this.interaction.turnRunning && !this.interaction.hasQueuedInput) {
				segments.push({ id: "mode-cycle", text: rawKeyHint("shift+tab", "switch mode"), optional: true });
			}
		}
		if ((this.data.backgroundShellCount ?? 0) > 0) {
			const count = this.data.backgroundShellCount ?? 0;
			segments.push({
				id: "background",
				text: `${count} background ${count === 1 ? "terminal" : "terminals"} running`,
				optional: false,
			});
		}
		if (this.data.taskProgress && this.data.taskProgress.total > 0) {
			segments.push({
				id: "task",
				text: `Tasks ${this.data.taskProgress.completed}/${this.data.taskProgress.total}`,
				optional: true,
			});
		}
		const liveState = sanitizeStatusText(this.data.liveState ?? "");
		if (liveState && liveState.toLowerCase() !== "idle") {
			segments.push({ id: "live", text: liveState, optional: false });
		}
		if (this.data.contextPercent !== undefined) {
			const percent = Number.isInteger(this.data.contextPercent)
				? this.data.contextPercent.toFixed(0)
				: this.data.contextPercent.toFixed(1);
			const prefix = this.data.contextSource === "runtime_estimate" ? "~" : "";
			const suffix = this.data.contextSource === "provider_previous" ? " prev" : "";
			const text = `${prefix}${percent}% ctx${suffix}`;
			const color = this.data.contextPercent > 90 ? "error" : this.data.contextPercent > 70 ? "warning" : "dim";
			segments.push({ id: "context", text: theme.fg(color, text), optional: true });
		}
		if (this.data.model) {
			segments.push({ id: "model", text: sanitizeStatusText(this.data.model), optional: true });
		}
		if (this.data.reasoningLevel) {
			segments.push({ id: "reasoning", text: `• ${sanitizeStatusText(this.data.reasoningLevel)}`, optional: true });
		}
		return segments;
	}

	private segmentsFit(actions: FooterSegment[], statuses: FooterSegment[], width: number): boolean {
		const left = actions.map((segment) => segment.text).join(" · ");
		const right = statuses.map((segment) => segment.text).join(" │ ");
		return visibleWidth(left) + (left && right ? 2 : 0) + visibleWidth(right) <= width;
	}

	private removeOptionalSegment(segments: FooterSegment[], id: string): void {
		const index = segments.findIndex((segment) => segment.id === id && segment.optional);
		if (index >= 0) segments.splice(index, 1);
	}
}
