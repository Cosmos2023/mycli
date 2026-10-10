import { Spacer } from "../../tui-core/components/spacer.ts";
import { Text } from "../../tui-core/components/text.ts";
import { Container, type Component } from "../../tui-core/tui.ts";
import { truncateToWidth, visibleWidth } from "../../tui-core/utils.ts";
import type { MycliShellFileChange, MycliShellFileChangeEntry } from "../../model.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import { keyHint } from "../shared/keybinding-hints.ts";
import { renderUnifiedDiff } from "./diff-renderer.ts";
import {
	TRANSCRIPT_BRANCH_INDENT,
	TRANSCRIPT_DETAIL_INDENT,
	TRANSCRIPT_HEADER_INDENT,
} from "./transcript-gutter.ts";


/** Codex bounds a collapsed patch preview to a three-line head per file. */
const DETAIL_PREVIEW_LINES = 3;

const VERBS = {
	add: "Added",
	update: "Edited",
	delete: "Deleted",
	rename: "Renamed",
} as const;

export class FileChangeComponent extends Container {
	private fileChange: MycliShellFileChange;

	constructor(fileChange: MycliShellFileChange) {
		super();
		this.fileChange = fileChange;
		this.rebuild();
	}

	updateFileChange(fileChange: MycliShellFileChange): void {
		this.fileChange = fileChange;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		const glyphs = uiGlyphs();
		if (this.fileChange.status === "error") {
			this.addChild(new Text(
				theme.fg("error", `${glyphs.error} ${errorSummary(this.fileChange.summary)}`),
				TRANSCRIPT_HEADER_INDENT,
				0,
			));
			if (this.fileChange.error) {
				this.addChild(new Text(
					theme.fg("error", `${glyphs.branch} ${this.fileChange.error}`),
					TRANSCRIPT_BRANCH_INDENT,
					0,
				));
			}
			return;
		}
		if (this.fileChange.status === "unchanged" || this.fileChange.files.length === 0) {
			const target = this.fileChange.target ?? this.fileChange.files[0]?.path;
			const text = target ? `No changes to ${target}` : "No changes";
			this.addChild(new Text(
				`${theme.fg("accent", glyphs.bullet)} ${text}`,
				TRANSCRIPT_HEADER_INDENT,
				0,
			));
			return;
		}
		const expanded = this.fileChange.expanded === true;
		if (this.fileChange.files.length === 1) {
			const file = this.fileChange.files[0]!;
			this.addChild(new FileChangeHeaderComponent(
				`${theme.fg("accent", glyphs.bullet)} ${VERBS[file.kind]} `,
				displayPath(file),
				formatCounts(file.addedLines, file.removedLines),
				TRANSCRIPT_HEADER_INDENT,
			));
			this.addChild(this.diffComponent(file, expanded));
			this.addDisclosure(expanded);
			return;
		}

		const counts = aggregateCounts(this.fileChange.files);
		this.addChild(new FileChangeHeaderComponent(
			`${theme.fg("accent", glyphs.bullet)} Edited `,
			`${this.fileChange.files.length} files`,
			formatCounts(counts.added, counts.removed),
			TRANSCRIPT_HEADER_INDENT,
		));
		this.fileChange.files.forEach((file, index) => {
			this.addChild(new FileChangeHeaderComponent(
				`${theme.fg("muted", glyphs.branch)} `,
				displayPath(file),
				formatCounts(file.addedLines, file.removedLines),
				TRANSCRIPT_BRANCH_INDENT,
			));
			this.addChild(this.diffComponent(file, expanded));
			if (index < this.fileChange.files.length - 1) {
				this.addChild(new Spacer(1));
			}
		});
		this.addDisclosure(expanded);
	}

	private diffComponent(file: MycliShellFileChangeEntry, expanded: boolean): FileDiffComponent {
		return new FileDiffComponent(file, TRANSCRIPT_DETAIL_INDENT, expanded ? undefined : DETAIL_PREVIEW_LINES);
	}

	private addDisclosure(expanded: boolean): void {
		if (!this.hasDiff()) return;
		this.addChild(new FileChangeDisclosureComponent(
			TRANSCRIPT_DETAIL_INDENT,
			expanded
				? () => theme.fg("muted", `${uiGlyphs().minus} Show less (${keyHint("app.tools.expand", "collapse")})`)
				: (width) => {
					const hidden = this.hiddenDiffLines(width);
					if (hidden === 0) return undefined;
					const noun = hidden === 1 ? "line" : "lines";
					return theme.fg("muted", `+ ${hidden} ${noun} (${keyHint("app.tools.expand", "to expand")})`);
				},
		));
	}

	private hasDiff(): boolean {
		return this.fileChange.files.some((file) => file.diff.trim().length > 0);
	}

	private hiddenDiffLines(width: number): number {
		let hidden = 0;
		for (const file of this.fileChange.files) {
			const rendered = renderFileDiff(file, width, TRANSCRIPT_DETAIL_INDENT);
			hidden += Math.max(0, rendered.length - DETAIL_PREVIEW_LINES);
		}
		return hidden;
	}

	/** True when the given rendered row is this block's expand/collapse affordance. */
	isDetailsToggleRow(row: number, width: number): boolean {
		if (this.fileChange.status !== "success" || !this.hasDiff()) return false;
		const rows = this.render(width).length;
		if (rows === 0) return false;
		if (this.fileChange.expanded === true) return row === rows - 1;
		return this.hiddenDiffLines(width) > 0 && row === rows - 1;
	}
}


class FileChangeHeaderComponent implements Component {
	constructor(
		private readonly lead: string,
		private readonly target: string,
		private readonly counts: string,
		private readonly indent: number,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const available = Math.max(1, width - this.indent * 2);
		const fixedWidth = visibleWidth(this.lead) + visibleWidth(this.counts) + 1;
		const targetWidth = Math.max(1, available - fixedWidth);
		const target = truncateToWidth(this.target.replace(/[\r\n\t]/gu, " "), targetWidth, "...");
		const content = `${this.lead}${target} ${this.counts}`;
		return [`${" ".repeat(this.indent)}${truncateToWidth(content, available, "", true)}`];
	}
}


class FileDiffComponent implements Component {
	constructor(
		private readonly file: MycliShellFileChangeEntry,
		private readonly indent: number,
		private readonly previewLines?: number,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		return renderFileDiff(this.file, width, this.indent, this.previewLines);
	}
}

/** Codex bounds a collapsed preview to the head of each file's diff, not the tail. */
function renderFileDiff(
	file: MycliShellFileChangeEntry,
	width: number,
	indent: number,
	previewLines?: number,
): string[] {
	if (!file.diff.trim()) return [];
	const lines = renderUnifiedDiff(file.diff, {
		width,
		indent,
		language: file.language,
	});
	return previewLines === undefined ? lines : lines.slice(0, previewLines);
}

/** Width-dependent disclosure row; renders nothing when the preview hides no lines. */
class FileChangeDisclosureComponent implements Component {
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		private readonly indent: number,
		private readonly label: (width: number) => string | undefined,
	) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedWidth !== width || !this.cachedLines) {
			const label = this.label(width);
			this.cachedLines = label ? new Text(label, this.indent, 0).render(width) : [];
			this.cachedWidth = width;
		}
		return this.cachedLines;
	}
}


function aggregateCounts(files: MycliShellFileChangeEntry[]): { added: number; removed: number } {
	return files.reduce(
		(counts, file) => ({
			added: counts.added + file.addedLines,
			removed: counts.removed + file.removedLines,
		}),
		{ added: 0, removed: 0 },
	);
}


function displayPath(file: MycliShellFileChangeEntry): string {
	return file.kind === "rename" && file.previousPath
		? `${file.previousPath} -> ${file.path}`
		: file.path;
}


function formatCounts(added: number, removed: number): string {
	return `(+${added} -${removed})`;
}


function errorSummary(summary: string): string {
	const normalized = summary.trim();
	return normalized || "Failed to apply file change";
}
