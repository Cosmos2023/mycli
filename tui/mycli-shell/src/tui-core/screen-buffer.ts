import { isImageLine } from "./terminal-image.ts";
import { sliceWithWidth, snapshotTerminalCells, type TerminalCellSnapshot } from "./utils.ts";

export const TERMINAL_SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

export interface TerminalLinePatch {
	readonly column: number;
	readonly content: string;
}

type SnapshotTerminalLine = (line: string) => TerminalCellSnapshot[] | null;

const DEFAULT_LINE_SNAPSHOT_CACHE_SIZE = 256;

/** Retains semantic cells so a rendered next line becomes the next frame's previous line. */
export class TerminalLineDiffer {
	private readonly snapshots = new Map<string, TerminalCellSnapshot[] | null>();
	private readonly snapshotLimit: number;

	constructor(
		maxSnapshots = DEFAULT_LINE_SNAPSHOT_CACHE_SIZE,
		private readonly snapshot: SnapshotTerminalLine = snapshotTerminalCells,
	) {
		this.snapshotLimit = Number.isSafeInteger(maxSnapshots) && maxSnapshots > 0
			? maxSnapshots
			: DEFAULT_LINE_SNAPSHOT_CACHE_SIZE;
	}

	diff(previousLine: string, nextLine: string, maxWidth: number): TerminalLinePatch | null {
		if (isImageLine(previousLine) || isImageLine(nextLine)) return null;
		return diffTerminalSnapshots(
			this.snapshotFor(previousLine),
			this.snapshotFor(nextLine),
			nextLine,
			maxWidth,
		);
	}

	private snapshotFor(line: string): TerminalCellSnapshot[] | null {
		if (this.snapshots.has(line)) {
			const cached = this.snapshots.get(line) ?? null;
			this.snapshots.delete(line);
			this.snapshots.set(line, cached);
			return cached;
		}
		const cells = this.snapshot(line);
		while (this.snapshots.size >= this.snapshotLimit) {
			const oldest = this.snapshots.keys().next().value;
			if (oldest === undefined) break;
			this.snapshots.delete(oldest);
		}
		this.snapshots.set(line, cells);
		return cells;
	}
}

/** Build an ANSI-safe suffix patch, or return null when the line needs a full repaint. */
export function diffTerminalLine(
	previousLine: string,
	nextLine: string,
	maxWidth: number,
): TerminalLinePatch | null {
	if (isImageLine(previousLine) || isImageLine(nextLine)) return null;
	return diffTerminalSnapshots(
		snapshotTerminalCells(previousLine),
		snapshotTerminalCells(nextLine),
		nextLine,
		maxWidth,
	);
}

function diffTerminalSnapshots(
	previous: TerminalCellSnapshot[] | null,
	next: TerminalCellSnapshot[] | null,
	nextLine: string,
	maxWidth: number,
): TerminalLinePatch | null {
	if (!previous || !next) return null;

	const comparedLength = Math.max(previous.length, next.length);
	let column = 0;
	while (column < comparedLength && cellsEqual(previous[column], next[column])) column++;
	if (column === comparedLength) return { column, content: "" };

	while (column > 0 && (previous[column]?.continuation || next[column]?.continuation)) {
		column--;
	}
	const availableWidth = Math.max(0, maxWidth - column);
	const suffix = sliceWithWidth(nextLine, column, availableWidth, true).text;
	return {
		column,
		content: `${TERMINAL_SEGMENT_RESET}${suffix}${TERMINAL_SEGMENT_RESET}\x1b[K`,
	};
}

function cellsEqual(
	left: TerminalCellSnapshot | undefined,
	right: TerminalCellSnapshot | undefined,
): boolean {
	if (!left || !right) return left === right;
	return (
		left.symbol === right.symbol &&
		left.width === right.width &&
		left.style === right.style &&
		left.continuation === right.continuation
	);
}
