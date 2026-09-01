import { Text } from "../tui-core/components/text.ts";
import type { Component } from "../tui-core/tui.ts";
import { truncateToWidth } from "../tui-core/utils.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { theme } from "../theme/theme.ts";
import { stableVariantIndex } from "../stable-variant.ts";
import { TRANSCRIPT_HEADER_INDENT } from "./transcript-gutter.ts";

const COMPLETION_PHRASES = Object.freeze([
	"Worked for",
	"Finished in",
	"Completed in",
	"Took",
] as const);

export class TurnCompletedComponent implements Component {
	constructor(
		private readonly durationMs: number,
		private readonly variantKey: string = String(durationMs),
	) {}

	invalidate(): void {}

	getRenderCacheKey(): number {
		return 0;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(0, width);
		if (safeWidth === 0) return [];
		const line = truncateToWidth(
			completionDurationText(this.durationMs, this.variantKey),
			safeWidth,
			"",
		);
		return ["", ...new Text(theme.fg("muted", line), TRANSCRIPT_HEADER_INDENT, 0).render(safeWidth)];
	}
}

export function completionDurationText(durationMs: number, variantKey: string): string {
	const phrase = COMPLETION_PHRASES[stableVariantIndex(variantKey, COMPLETION_PHRASES.length)]!;
	return `${uiGlyphs().completion} ${phrase} ${formatElapsedCompact(elapsedSecondsFor(durationMs))}`;
}

export function elapsedSecondsFor(durationMs: number): number {
	return Math.max(0, Math.floor(durationMs / 1_000));
}

export function formatElapsedCompact(elapsedSeconds: number): string {
	if (elapsedSeconds < 60) {
		return `${elapsedSeconds}s`;
	}
	if (elapsedSeconds < 3_600) {
		const minutes = Math.floor(elapsedSeconds / 60);
		const seconds = elapsedSeconds % 60;
		return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	}
	const hours = Math.floor(elapsedSeconds / 3_600);
	const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
	const seconds = elapsedSeconds % 60;
	return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}
