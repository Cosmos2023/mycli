import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container, type Component } from "../tui-core/tui.ts";
import type { MycliShellFileChange, MycliShellFileChangeEntry } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { renderUnifiedDiff } from "./diff-renderer.ts";


const VERBS = {
	add: "Added",
	update: "Edited",
	delete: "Deleted",
	rename: "Renamed",
} as const;

type FileChangeGlyphs = {
	bullet: string;
	branch: string;
	error: string;
};


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
		const glyphs = glyphsForTerminal();
		if (this.fileChange.status === "error") {
			this.addChild(new Text(theme.fg("error", `${glyphs.error} ${errorSummary(this.fileChange.summary)}`), 1, 0));
			if (this.fileChange.error) {
				this.addChild(new Text(theme.fg("error", `${glyphs.branch} ${this.fileChange.error}`), 2, 0));
			}
			return;
		}
		if (this.fileChange.status === "unchanged" || this.fileChange.files.length === 0) {
			const target = this.fileChange.target ?? this.fileChange.files[0]?.path;
			const text = target ? `No changes to ${target}` : "No changes";
			this.addChild(new Text(`${theme.fg("accent", glyphs.bullet)} ${text}`, 1, 0));
			return;
		}
		if (this.fileChange.files.length === 1) {
			const file = this.fileChange.files[0]!;
			this.addChild(new Text(this.singleFileHeader(file, glyphs), 1, 0));
			this.addChild(new FileDiffComponent(file, 4));
			return;
		}

		const counts = aggregateCounts(this.fileChange.files);
		this.addChild(new Text(
			`${theme.fg("accent", glyphs.bullet)} Edited ${this.fileChange.files.length} files ${formatCounts(counts.added, counts.removed)}`,
			1,
			0,
		));
		this.fileChange.files.forEach((file, index) => {
			this.addChild(new Text(`${theme.fg("muted", glyphs.branch)} ${displayPath(file)} ${formatCounts(file.addedLines, file.removedLines)}`, 2, 0));
			this.addChild(new FileDiffComponent(file, 4));
			if (index < this.fileChange.files.length - 1) {
				this.addChild(new Spacer(1));
			}
		});
	}

	private singleFileHeader(file: MycliShellFileChangeEntry, glyphs: FileChangeGlyphs): string {
		return `${theme.fg("accent", glyphs.bullet)} ${VERBS[file.kind]} ${displayPath(file)} ${formatCounts(file.addedLines, file.removedLines)}`;
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


function glyphsForTerminal(): FileChangeGlyphs {
	if (process.env.TERM?.toLowerCase() === "dumb") {
		return { bullet: "*", branch: "\\", error: "x" };
	}
	return { bullet: "•", branch: "└", error: "×" };
}
