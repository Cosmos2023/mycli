/**
 * Reads a command's complete stored output for the transcript.
 *
 * The transcript only carries a bounded preview, so an expanded row loads the persisted chunks on
 * demand. Chunks are append-only and ordered, which makes this a forward scan: the caller keeps the
 * cursor from the previous view and asks for more only when the reader asks for it.
 */

/** Characters requested per `shell.output.load` page. */
export const SHELL_OUTPUT_VIEW_PAGE_CHARS = 65_536;
/** Characters a single expanded row is allowed to hold. */
export const SHELL_OUTPUT_VIEW_MAX_CHARS = 262_144;

export interface MycliShellShellOutputChunk {
	readonly sequence: number;
	readonly output: string;
	readonly omittedBefore: number;
	readonly cursorEnd: number;
}

export interface MycliShellShellOutputPage {
	readonly chunks: readonly MycliShellShellOutputChunk[];
	/** Sequence to continue from; null when the store holds nothing newer. */
	readonly nextAfterSequence: number | null;
	/** Total characters the shell had produced when the page was read. */
	readonly outputChars: number;
}

export interface MycliShellShellOutputView {
	readonly text: string;
	/** Characters the store no longer holds before `text`. */
	readonly omittedBefore: number;
	/** Characters dropped between retained chunks inside `text`. */
	readonly omittedInside: number;
	/** End cursor of the loaded text, in the shell's character space. */
	readonly cursor: number;
	/** Characters the shell had produced when this view was loaded. */
	readonly outputChars: number;
	readonly loadedChars: number;
	/** Sequence to continue from; null when the store had nothing newer at load time. */
	readonly nextAfterSequence: number | null;
}

export interface MycliShellShellOutputLoadRequest {
	readonly shellId: string;
	readonly callId?: string;
	readonly afterSequence?: number;
	readonly limitChars?: number;
}

/**
 * Reads one `shell.output.load` page. Chunk text is preserved verbatim, including whitespace, so a
 * rendered row shows exactly what the process wrote.
 */
export function shellOutputPageFromResult(
	result: Record<string, unknown>,
): MycliShellShellOutputPage | null {
	const raw = result.chunks;
	if (!Array.isArray(raw)) return null;
	const chunks: MycliShellShellOutputChunk[] = [];
	for (const value of raw) {
		if (typeof value !== "object" || value === null) continue;
		const record = value as Record<string, unknown>;
		const output = typeof record.output === "string" ? record.output : null;
		const sequence = numberOrNull(record.sequence);
		if (output === null || sequence === null) continue;
		chunks.push({
			sequence,
			output,
			omittedBefore: numberOrNull(record.omitted_before) ?? 0,
			cursorEnd: numberOrNull(record.cursor_end) ?? 0,
		});
	}
	return {
		chunks,
		nextAfterSequence: numberOrNull(result.next_after_sequence),
		outputChars: numberOrNull(result.output_chars) ?? 0,
	};
}

export interface LoadShellOutputViewInput {
	readonly shellId: string;
	readonly callId?: string;
	readonly load: (request: MycliShellShellOutputLoadRequest) => Promise<MycliShellShellOutputPage>;
	/** Existing view to extend; omitted for the first load. */
	readonly previous?: MycliShellShellOutputView;
	readonly maxChars?: number;
	readonly signal?: AbortSignal;
}

/** Loads forward from `previous` until the store runs out or the row budget is reached. */
export async function loadShellOutputView(
	input: LoadShellOutputViewInput,
): Promise<MycliShellShellOutputView> {
	const maxChars = Math.max(1, input.maxChars ?? SHELL_OUTPUT_VIEW_MAX_CHARS);
	let text = input.previous?.text ?? "";
	let omittedBefore = input.previous?.omittedBefore ?? 0;
	let omittedInside = input.previous?.omittedInside ?? 0;
	let cursor = input.previous?.cursor ?? 0;
	let outputChars = input.previous?.outputChars ?? 0;
	let loadedChars = input.previous?.loadedChars ?? 0;
	let nextAfterSequence = input.previous?.nextAfterSequence ?? undefined;
	// Only the very first chunk of the whole view describes the store's evicted head; every later
	// gap is an omission inside the text and has to be marked where it happened.
	let leading = input.previous === undefined;
	for (;;) {
		input.signal?.throwIfAborted();
		const requestedAfterSequence = nextAfterSequence;
		const page = await input.load({
			shellId: input.shellId,
			...(input.callId ? { callId: input.callId } : {}),
			...(requestedAfterSequence === undefined ? {} : { afterSequence: requestedAfterSequence }),
			limitChars: SHELL_OUTPUT_VIEW_PAGE_CHARS,
		});
		// A page that repeats the cursor it was asked for carries nothing new; stop instead of
		// spinning if a store ever answers that way.
		if (page.nextAfterSequence !== null && page.nextAfterSequence === requestedAfterSequence) break;
		outputChars = Math.max(outputChars, page.outputChars);
		for (const chunk of page.chunks) {
			if (leading) {
				omittedBefore = chunk.omittedBefore;
				leading = false;
			} else if (chunk.omittedBefore > 0) {
				text += omissionMarker(chunk.omittedBefore);
				omittedInside += chunk.omittedBefore;
			}
			text += chunk.output;
			loadedChars += chunk.output.length;
			cursor = Math.max(cursor, chunk.cursorEnd);
		}
		nextAfterSequence = page.nextAfterSequence ?? undefined;
		if (page.nextAfterSequence === null || loadedChars >= maxChars) break;
	}
	return Object.freeze({
		text,
		omittedBefore,
		omittedInside,
		cursor,
		outputChars,
		loadedChars,
		nextAfterSequence: nextAfterSequence ?? null,
	});
}

/** True when the store can still produce characters this view does not hold. */
export function shellOutputViewHasMore(
	view: MycliShellShellOutputView,
	producedChars: number,
): boolean {
	return view.nextAfterSequence !== null || view.cursor < producedChars;
}

/** Characters the store can still produce, when the total is known. */
export function shellOutputViewRemaining(
	view: MycliShellShellOutputView,
	producedChars: number,
): number {
	return Math.max(0, Math.max(producedChars, view.outputChars) - view.cursor);
}

export function shellOutputOmissionMarker(omittedChars: number): string {
	return omissionMarker(omittedChars);
}

function omissionMarker(omittedChars: number): string {
	return `\n… ${omittedChars} chars omitted …\n`;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
