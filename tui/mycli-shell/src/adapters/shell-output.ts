import type {
	MycliShellTranscriptOutput,
	MycliShellTranscriptOutputRequest,
} from "../model.ts";

type JsonObject = Record<string, unknown>;

const PAGE_LIMIT_CHARS = 65_536;
const MAX_PAGES = 4_096;

type ShellOutputChunk = {
	sequence: number;
	cursorStart: number;
	cursorEnd: number;
	omittedBefore: number;
	output: string;
};

type ShellOutputPage = {
	chunks: ShellOutputChunk[];
	nextAfterSequence: number | null;
	available: boolean;
	complete: boolean;
	omittedChars: number;
	capturedChars: number;
	outputChars: number;
};

export async function loadFullShellOutput(
	send: (method: string, params: JsonObject) => Promise<JsonObject>,
	request: MycliShellTranscriptOutputRequest,
): Promise<MycliShellTranscriptOutput> {
	let afterSequence = 0;
	let expectedCursor = 0;
	let output = "";
	let markedOmittedChars = 0;
	let latestPage: ShellOutputPage | undefined;
	for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
		const requestedAfterSequence = afterSequence;
		const payload = await send("shell.output.load", {
			session_id: request.sessionId,
			shell_id: request.shellId,
			...(request.callId ? { call_id: request.callId } : {}),
			after_sequence: afterSequence,
			limit_chars: PAGE_LIMIT_CHARS,
		});
		const page = shellOutputPage(payload);
		latestPage = page;
		for (const chunk of page.chunks) {
			if (chunk.sequence <= afterSequence || chunk.cursorStart < expectedCursor) {
				throw new Error("Gateway returned non-monotonic Shell transcript output.");
			}
			const gap = Math.max(chunk.omittedBefore, chunk.cursorStart - expectedCursor);
			if (gap > 0) {
				output += unavailableOutputMarker(gap);
				markedOmittedChars += gap;
			}
			output += chunk.output;
			expectedCursor = chunk.cursorEnd;
			afterSequence = chunk.sequence;
		}
		if (page.nextAfterSequence === null) break;
		if (
			page.chunks.length === 0
			|| page.nextAfterSequence <= requestedAfterSequence
			|| page.nextAfterSequence !== afterSequence
		) {
			throw new Error("Gateway returned a stalled Shell transcript page.");
		}
		afterSequence = page.nextAfterSequence;
		if (pageIndex === MAX_PAGES - 1) {
			throw new Error("Shell transcript output exceeded the page limit.");
		}
	}
	const page = latestPage ?? emptyPage();
	if (page.available && !page.complete) {
		const unmarkedOmittedChars = Math.max(0, page.omittedChars - markedOmittedChars);
		if (unmarkedOmittedChars > 0 || markedOmittedChars === 0) {
			output += incompleteOutputMarker(unmarkedOmittedChars);
		}
	}
	return {
		...request,
		output,
		available: page.available,
		complete: page.complete,
		omittedChars: page.omittedChars,
		capturedChars: page.capturedChars,
		outputChars: page.outputChars,
	};
}

function shellOutputPage(payload: JsonObject): ShellOutputPage {
	if (!Array.isArray(payload.chunks)) throw new Error("Gateway returned invalid Shell transcript chunks.");
	const nextAfterSequence = payload.next_after_sequence === null
		? null
		: nonNegativeInteger(payload.next_after_sequence, "next_after_sequence");
	return {
		chunks: payload.chunks.map(shellOutputChunk),
		nextAfterSequence,
		available: booleanValue(payload.available, "available"),
		complete: booleanValue(payload.complete, "complete"),
		omittedChars: nonNegativeInteger(payload.omitted_chars, "omitted_chars"),
		capturedChars: nonNegativeInteger(payload.captured_chars, "captured_chars"),
		outputChars: nonNegativeInteger(payload.output_chars, "output_chars"),
	};
}

function shellOutputChunk(value: unknown): ShellOutputChunk {
	const chunk = recordValue(value);
	const output = chunk.output;
	if (typeof output !== "string" || output.length === 0) {
		throw new Error("Gateway returned an invalid Shell transcript output chunk.");
	}
	const cursorStart = nonNegativeInteger(chunk.cursor_start, "cursor_start");
	const cursorEnd = nonNegativeInteger(chunk.cursor_end, "cursor_end");
	if (cursorEnd - cursorStart !== output.length) {
		throw new Error("Gateway returned a Shell transcript chunk with an invalid cursor range.");
	}
	return {
		sequence: nonNegativeInteger(chunk.sequence, "sequence"),
		cursorStart,
		cursorEnd,
		omittedBefore: nonNegativeInteger(chunk.omitted_before, "omitted_before"),
		output,
	};
}

function unavailableOutputMarker(chars: number): string {
	return `${chars > 0 ? `\n[... ${chars} earlier output characters unavailable ...]\n` : ""}`;
}

function incompleteOutputMarker(chars: number): string {
	const detail = chars > 0 ? ` At least ${chars} additional characters are unavailable.` : "";
	return `\n[... Shell output is incomplete.${detail} ...]\n`;
}

function emptyPage(): ShellOutputPage {
	return {
		chunks: [],
		nextAfterSequence: null,
		available: false,
		complete: false,
		omittedChars: 0,
		capturedChars: 0,
		outputChars: 0,
	};
}

function recordValue(value: unknown): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Gateway returned an invalid Shell transcript payload.");
	}
	return value as JsonObject;
}

function nonNegativeInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Gateway returned invalid ${name}.`);
	}
	return value;
}

function booleanValue(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new Error(`Gateway returned invalid ${name}.`);
	return value;
}
