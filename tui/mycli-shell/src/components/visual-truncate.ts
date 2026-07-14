import { Text } from "../tui-core/index.ts";

export type VisualTruncateResult = {
	visualLines: string[];
	skippedCount: number;
};

export function truncateToVisualLines(text: string, maxVisualLines: number, width: number, paddingX = 0): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}
	const visualLines = new Text(text, paddingX, 0).render(width);
	if (visualLines.length <= maxVisualLines) {
		return { visualLines, skippedCount: 0 };
	}
	return {
		visualLines: visualLines.slice(-maxVisualLines),
		skippedCount: visualLines.length - maxVisualLines,
	};
}

export function truncateVisualLinesBalanced(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX = 0,
	omissionText: (skippedCount: number) => string = (skippedCount) => `... ${skippedCount} more lines`,
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}
	const visualLines = new Text(text, paddingX, 0).render(width);
	if (visualLines.length <= maxVisualLines) {
		return { visualLines, skippedCount: 0 };
	}
	const retainedLineCount = Math.max(0, maxVisualLines - 1);
	const headLineCount = Math.ceil(retainedLineCount / 2);
	const tailLineCount = retainedLineCount - headLineCount;
	const skippedCount = visualLines.length - retainedLineCount;
	const marker = new Text(omissionText(skippedCount), paddingX, 0).render(width)[0];
	return {
		visualLines: [
			...visualLines.slice(0, headLineCount),
			...(marker ? [marker] : []),
			...(tailLineCount > 0 ? visualLines.slice(-tailLineCount) : []),
		],
		skippedCount,
	};
}
