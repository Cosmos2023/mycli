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
