import { isImageLine } from "./terminal-image.ts";
import { sliceWithWidth, snapshotTerminalCells, type TerminalCellSnapshot } from "./utils.ts";

export const TERMINAL_SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

export interface TerminalLinePatch {
	readonly column: number;
	readonly content: string;
}

/** Build an ANSI-safe suffix patch, or return null when the line needs a full repaint. */
export function diffTerminalLine(
	previousLine: string,
	nextLine: string,
	maxWidth: number,
): TerminalLinePatch | null {
	if (isImageLine(previousLine) || isImageLine(nextLine)) return null;
	const previous = snapshotTerminalCells(previousLine);
	const next = snapshotTerminalCells(nextLine);
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
