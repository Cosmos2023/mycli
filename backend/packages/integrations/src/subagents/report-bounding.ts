export interface BoundSubagentReportOptions {
	/** Maximum number of characters the bounded report may contain. */
	readonly maxChars: number;
	/** Maximum encoded size in bytes; omit to bound by characters only. */
	readonly maxBytes?: number;
	/** Artifact path advertised to the model when the report is cut. */
	readonly outputFile?: string;
	/** Encoded size of the text as the transport will emit it, in bytes. */
	readonly encodedLength?: (value: string) => number;
}

/**
 * Bounds a subagent report without hiding that it was cut. An oversized report
 * keeps its leading characters and ends with a marker that names how much was
 * dropped and, when the artifact path is known, where the complete report lives.
 */
export function boundSubagentReport(
	value: string,
	options: BoundSubagentReportOptions,
): string {
	const maxChars = nonNegativeInteger(options.maxChars, "maxChars");
	const maxBytes = options.maxBytes === undefined
		? undefined
		: nonNegativeInteger(options.maxBytes, "maxBytes");
	const encodedLength = options.encodedLength ?? defaultEncodedLength;
	const outputFile = options.outputFile?.trim() || undefined;
	const characters = [...value];
	const fits = (text: string): boolean => text.length <= maxChars
		&& (maxBytes === undefined || encodedLength(text) <= maxBytes);
	if (fits(value)) return value;

	let low = 0;
	let high = characters.length;
	let bounded: string | undefined;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = candidateText(characters, middle, outputFile);
		if (fits(candidate)) {
			bounded = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	if (bounded !== undefined) return bounded;

	// The marker alone cannot fit. Keep whatever still fits so the cut stays visible.
	const marker = truncationMarker(0, characters.length, outputFile);
	return clipToBudget(marker, maxChars, maxBytes, encodedLength)
		|| clipToBudget(value, maxChars, maxBytes, encodedLength);
}

function candidateText(
	characters: readonly string[],
	shown: number,
	outputFile: string | undefined,
): string {
	const body = characters.slice(0, shown).join("");
	if (shown >= characters.length) return body;
	return body + truncationMarker(shown, characters.length, outputFile);
}

function truncationMarker(shown: number, total: number, outputFile: string | undefined): string {
	return "\n\n[report truncated: showing "
		+ `${shown} of ${total} characters.`
		+ (outputFile ? ` Full report: ${outputFile}]` : " The remainder was dropped.]");
}

function clipToBudget(
	value: string,
	maxChars: number,
	maxBytes: number | undefined,
	encodedLength: (value: string) => number,
): string {
	let kept = "";
	for (const character of value) {
		const candidate = kept + character;
		if (candidate.length > maxChars) break;
		if (maxBytes !== undefined && encodedLength(candidate) > maxBytes) break;
		kept = candidate;
	}
	return kept;
}

function defaultEncodedLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function nonNegativeInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${field} must be a non-negative safe integer`);
	}
	return value;
}