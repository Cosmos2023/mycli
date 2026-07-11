import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Component } from "../tui-core/tui.ts";
import { truncateToWidth, visibleWidth } from "../tui-core/utils.ts";
import type { MycliShellFooterData } from "../model.ts";
import { theme } from "../theme/theme.ts";

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined = process.env.HOME || process.env.USERPROFILE): string {
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

export class FooterComponent implements Component {
	constructor(private readonly data: MycliShellFooterData) {}

	invalidate(): void {}

	render(width: number): string[] {
		const cwdParts = [
			formatCwdForFooter(this.data.cwd),
			this.data.gitBranch ? `(${this.data.gitBranch})` : "",
			this.data.sessionName ? `• ${this.data.sessionName}` : "",
		].filter(Boolean);
		const cwdLine = truncateToWidth(theme.fg("dim", cwdParts.join(" ")), width, theme.fg("dim", "..."));

		const statsParts: string[] = [
			this.data.totalInputTokens ? `↑${formatTokens(this.data.totalInputTokens)}` : undefined,
			this.data.totalOutputTokens ? `↓${formatTokens(this.data.totalOutputTokens)}` : undefined,
			this.data.cacheReadTokens ? `R${formatTokens(this.data.cacheReadTokens)}` : undefined,
			this.data.cacheWriteTokens ? `W${formatTokens(this.data.cacheWriteTokens)}` : undefined,
			this.data.cacheHitRate !== undefined ? `CH${this.data.cacheHitRate.toFixed(1)}%` : undefined,
			this.costText(),
			this.contextText(),
			this.data.trust ? `trust ${this.data.trust}` : undefined,
			this.data.collaborationMode ? `mode ${this.data.collaborationMode}` : undefined,
			this.backgroundShellText(),
			this.data.liveState,
		].filter((part): part is string => Boolean(part));

		let left = statsParts.join(" ");
		if (!left) {
			left = "ready";
		}
		if (visibleWidth(left) > width) {
			left = truncateToWidth(left, width, "...");
		}

		const rightWithoutProvider = [this.data.model ?? "no-model", this.data.reasoningLevel ? `• ${this.data.reasoningLevel}` : ""]
			.filter(Boolean)
			.join(" ");
		let right = this.data.provider ? `(${this.data.provider}) ${rightWithoutProvider}` : rightWithoutProvider;
		const minPadding = 2;
		let leftWidth = visibleWidth(left);
		if (leftWidth + minPadding + visibleWidth(right) > width && this.data.provider) {
			right = rightWithoutProvider;
		}
		const rightWidth = visibleWidth(right);
		const totalNeeded = leftWidth + minPadding + rightWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			statsLine = `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
		} else {
			const availableRight = width - leftWidth - minPadding;
			if (availableRight > 0) {
				const truncatedRight = truncateToWidth(right, availableRight, "");
				statsLine = `${left}${" ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncatedRight)))}${truncatedRight}`;
			} else {
				statsLine = left;
			}
		}

		const lines = [cwdLine, theme.fg("dim", statsLine)];
		for (const status of this.data.extensionStatuses ?? []) {
			lines.push(truncateToWidth(theme.fg("dim", sanitizeStatusText(status)), width, theme.fg("dim", "...")));
		}
		return lines;
	}

	private backgroundShellText(): string | undefined {
		const count = this.data.backgroundShellCount ?? 0;
		if (count <= 0) return undefined;
		const noun = count === 1 ? "terminal" : "terminals";
		return `${count} background ${noun} running · /ps to view · /stop to close`;
	}

	private costText(): string | undefined {
		if (!this.data.costUsd && !this.data.usingSubscription) {
			return undefined;
		}
		return `$${(this.data.costUsd ?? 0).toFixed(3)}${this.data.usingSubscription ? " (sub)" : ""}`;
	}

	private contextText(): string | undefined {
		if (this.data.contextPercent === undefined || this.data.contextWindow === undefined) {
			return undefined;
		}
		const auto = this.data.autoCompact ? " (auto)" : "";
		const text = `${this.data.contextPercent.toFixed(1)}%/${formatTokens(this.data.contextWindow)}${auto}`;
		if (this.data.contextPercent > 90) {
			return theme.fg("error", text);
		}
		if (this.data.contextPercent > 70) {
			return theme.fg("warning", text);
		}
		return text;
	}
}
