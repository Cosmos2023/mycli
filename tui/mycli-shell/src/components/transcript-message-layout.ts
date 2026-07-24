import { truncateToWidth } from "../tui-core/utils.ts";

export const TRANSCRIPT_MESSAGE_PREFIX_WIDTH = 2;

export function transcriptMessageContentWidth(width: number): number {
	const safeWidth = Math.max(1, Math.floor(width));
	return Math.max(1, safeWidth - TRANSCRIPT_MESSAGE_PREFIX_WIDTH);
}

export function renderTranscriptMessageLines(
	contentLines: string[],
	width: number,
	firstLinePrefix: string,
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const continuationPrefix = " ".repeat(TRANSCRIPT_MESSAGE_PREFIX_WIDTH);
	return contentLines.map((line, index) =>
		truncateToWidth(
			`${index === 0 ? firstLinePrefix : continuationPrefix}${line}`,
			safeWidth,
			"",
			true,
		),
	);
}
