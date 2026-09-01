import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container, type Component } from "../tui-core/tui.ts";
import { truncateToWidth, visibleWidth } from "../tui-core/utils.ts";
import type { MycliShellFileChange, MycliShellFileChangeEntry } from "../model.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { theme } from "../theme/theme.ts";
import { renderUnifiedDiff } from "./diff-renderer.ts";
import {
	TRANSCRIPT_BRANCH_INDENT,
	TRANSCRIPT_DETAIL_INDENT,
	TRANSCRIPT_HEADER_INDENT,
} from "./transcript-gutter.ts";


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
		if (this.fileChange.files.length === 1) {
			const file = this.fileChange.files[0]!;
			this.addChild(new FileChangeHeaderComponent(
				`${theme.fg("accent", glyphs.bullet)} ${VERBS[file.kind]} `,
				displayPath(file),
				formatCounts(file.addedLines, file.removedLines),
				TRANSCRIPT_HEADER_INDENT,
			));
			this.addChild(new FileDiffComponent(file, TRANSCRIPT_DETAIL_INDENT));
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
			this.addChild(new FileDiffComponent(file, TRANSCRIPT_DETAIL_INDENT));
			if (index < this.fileChange.files.length - 1) {
				this.addChild(new Spacer(1));
			}
		});
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
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.file.diff.trim()) return [];
		return renderUnifiedDiff(this.file.diff, {
			width,
			indent: this.indent,
			language: this.file.language,
		});
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
