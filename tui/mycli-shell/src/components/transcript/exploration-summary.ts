import type { ContextActivity } from "../../transcript/context-activity.ts";
import { Spacer } from "../../tui-core/components/spacer.ts";
import { Text } from "../../tui-core/components/text.ts";
import { Container } from "../../tui-core/tui.ts";
import { visibleWidth, wrapTextWithAnsi } from "../../tui-core/utils.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import { TRANSCRIPT_BRANCH_INDENT, TRANSCRIPT_HEADER_INDENT } from "./transcript-gutter.ts";

export class ExplorationSummaryComponent extends Container {
	constructor(activities: readonly ContextActivity[]) {
		super();
		const running = activities.some((activity) => activity.status === "running");
		const failures = activities.filter((activity) => activity.status === "error").length;
		const cancelled = activities.filter((activity) => activity.status === "cancelled").length;
		const notices = [failures ? `${failures} failed` : "", cancelled ? `${cancelled} cancelled` : ""].filter(Boolean);
		const marker = theme.fg(running ? "accent" : "dim", uiGlyphs().bullet);
		const status = notices.length ? theme.fg("error", ` ${uiGlyphs().separator} ${notices.join(", ")}`) : "";
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${marker} ${theme.bold(running ? "Exploring" : "Explored")}${status}`, TRANSCRIPT_HEADER_INDENT, 0));
		const rows = coalesceReads(activities);
		this.addChild({
			render: (width: number): string[] => renderRows(rows, width),
			invalidate: (): void => {},
		});
	}
}

function coalesceReads(activities: readonly ContextActivity[]): ContextActivity[] {
	const rows: ContextActivity[] = [];
	let pendingRead: ContextActivity | undefined;
	const readTargets = new Set<string>();
	const flushRead = (): void => {
		if (pendingRead) rows.push({ ...pendingRead, targets: [...readTargets] });
		pendingRead = undefined;
		readTargets.clear();
	};
	for (const activity of activities) {
		// Keep failed and cancelled reads distinct so a later successful retry cannot hide them.
		if (activity.kind !== "read" || activity.status === "error" || activity.status === "cancelled") {
			flushRead();
			rows.push(activity);
			continue;
		}
		pendingRead ??= activity;
		for (const target of activity.targets) readTargets.add(target);
	}
	flushRead();
	return rows;
}

function renderRows(rows: readonly ContextActivity[], width: number): string[] {
	const lines: string[] = [];
	const branch = `${" ".repeat(TRANSCRIPT_BRANCH_INDENT)}${uiGlyphs().branch} `;
	const gutter = " ".repeat(visibleWidth(branch));
	for (const row of rows) {
		const label = `${theme.fg("accent", row.label)} `;
		const target = row.targets.join(theme.fg("dim", ", "));
		const scope = row.scope ? `${theme.fg("dim", " in ")}${row.scope}` : "";
		const status = row.status === "error" ? theme.fg("error", " (failed)")
			: row.status === "cancelled" ? theme.fg("error", " (cancelled)") : "";
		const indent = `${gutter}${" ".repeat(visibleWidth(label))}`;
		const firstPrefix = lines.length === 0 ? theme.fg("dim", branch) : gutter;
		if (width <= visibleWidth(indent)) {
			lines.push(...wrapTextWithAnsi(`${firstPrefix}${label}${target}${scope}${status}`, Math.max(1, width)));
			continue;
		}
		const wrapped = wrapTextWithAnsi(`${target}${scope}${status}`, width - visibleWidth(indent));
		lines.push(...wrapped.map((line, index) => `${index === 0 ? `${firstPrefix}${label}` : indent}${line}`));
	}
	return lines;
}
