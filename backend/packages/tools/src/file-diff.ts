import { createTwoFilesPatch } from "diff";

const MAX_DIFF_CHARS = 200_000;
const MAX_DIFF_LINES = 5_000;

export interface BoundedFileDiff {
	readonly diff: string;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly truncated: boolean;
	readonly omittedChars: number;
}

export function createBoundedUnifiedDiff(
	path: string,
	before: string,
	after: string,
): BoundedFileDiff {
	const full = createTwoFilesPatch(
		`${path}:before`,
		`${path}:after`,
		normalizeNewlines(before),
		normalizeNewlines(after),
		"",
		"",
		{ context: 3 },
	);
	const { addedLines, removedLines } = countChanges(full);
	const bounded = boundDiff(full);
	return {
		diff: bounded.value,
		addedLines,
		removedLines,
		truncated: bounded.omittedChars > 0,
		omittedChars: bounded.omittedChars,
	};
}

function normalizeNewlines(value: string): string {
	return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function countChanges(diff: string): { readonly addedLines: number; readonly removedLines: number } {
	let addedLines = 0;
	let removedLines = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) {
			addedLines += 1;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			removedLines += 1;
		}
	}
	return { addedLines, removedLines };
}

function boundDiff(diff: string): { readonly value: string; readonly omittedChars: number } {
	const lines = splitLinesWithEndings(diff);
	if (diff.length <= MAX_DIFF_CHARS && lines.length <= MAX_DIFF_LINES) {
		return { value: diff, omittedChars: 0 };
	}

	const retainedLimit = Math.max(2, MAX_DIFF_LINES - 2);
	let headCount = Math.min(lines.length, Math.floor(retainedLimit / 2));
	let tailCount = Math.min(lines.length - headCount, retainedLimit - headCount);
	while (headCount + tailCount > 2) {
		const candidate = boundedLineCandidate(lines, headCount, tailCount);
		if (candidate.value.length <= MAX_DIFF_CHARS) {
			return candidate;
		}
		const headChars = lines.slice(0, headCount).join("").length;
		const tailChars = lines.slice(lines.length - tailCount).join("").length;
		if (headChars >= tailChars && headCount > 1) {
			headCount -= 1;
		} else if (tailCount > 1) {
			tailCount -= 1;
		} else {
			break;
		}
	}
	return boundDiffByChars(diff);
}

function boundedLineCandidate(
	lines: readonly string[],
	headCount: number,
	tailCount: number,
): { readonly value: string; readonly omittedChars: number } {
	const head = lines.slice(0, headCount).join("");
	const tail = lines.slice(lines.length - tailCount).join("");
	const omittedChars = Math.max(0, lines.join("").length - head.length - tail.length);
	return {
		value: `${head}... (diff truncated, ${omittedChars} characters omitted) ...\n${tail}`,
		omittedChars,
	};
}

function boundDiffByChars(diff: string): { readonly value: string; readonly omittedChars: number } {
	const markerReserve = 80;
	const retained = Math.max(0, MAX_DIFF_CHARS - markerReserve);
	const headCount = Math.floor(retained / 2);
	const tailCount = retained - headCount;
	const omittedChars = Math.max(0, diff.length - headCount - tailCount);
	const marker = `\n... (diff truncated, ${omittedChars} characters omitted) ...\n`;
	const value = `${diff.slice(0, headCount)}${marker}${diff.slice(diff.length - tailCount)}`;
	return { value: value.slice(0, MAX_DIFF_CHARS), omittedChars };
}

function splitLinesWithEndings(value: string): readonly string[] {
	return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
