import fs from "node:fs";
import tty from "node:tty";
import { normalizeAppleTerminalInput, isAppleTerminalSession, type Terminal } from "../tui-core/terminal.ts";
import { setKittyProtocolActive } from "../tui-core/keys.ts";
import { OutputBackpressureTracker } from "../tui-core/output-backpressure.ts";
import { StdinBuffer } from "../tui-core/stdin-buffer.ts";

export type TtyStreams = {
	input: tty.ReadStream;
	output: tty.WriteStream;
	close: () => void;
};

export class TtyOpenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TtyOpenError";
	}
}

type OpenTtyOptions = {
	platform?: NodeJS.Platform;
	stdin?: tty.ReadStream;
	stdout?: tty.WriteStream;
	openSync?: (path: string, flags: string) => number;
};

type ResizeSignalSource = {
	on(event: "SIGWINCH", listener: () => void): unknown;
	removeListener(event: "SIGWINCH", listener: () => void): unknown;
};

type StreamTerminalOptions = {
	platform?: NodeJS.Platform;
	resizeSignalSource?: ResizeSignalSource;
	alternateScreen?: boolean;
};

type TtyWriteStreamWithHandle = tty.WriteStream & {
	_handle?: {
		getWindowSize(size: number[]): number;
	};
};

export function openTtyStreams(options: OpenTtyOptions = {}): TtyStreams {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") {
		const input = options.stdin ?? process.stdin;
		const output = options.stdout ?? process.stdout;
		if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
			throw new TtyOpenError("mycli shell TUI requires an interactive TTY with raw input support on Windows.");
		}
		return {
			input,
			output,
			close: () => {},
		};
	}

	const openSync = options.openSync ?? fs.openSync;
	let inputFd: number;
	let outputFd: number;
	try {
		inputFd = openSync("/dev/tty", "r");
		outputFd = openSync("/dev/tty", "w");
	} catch (error) {
		const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
		throw new TtyOpenError(`Unable to open /dev/tty for mycli shell TUI.${detail}`);
	}
	const input = new tty.ReadStream(inputFd);
	const output = new tty.WriteStream(outputFd);
	return {
		input,
		output,
		close: () => {
			input.destroy();
			output.end();
		},
	};
}

export class StreamTerminal implements Terminal {
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private sigwinchHandler?: () => void;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private _kittyProtocolActive = false;
	private readonly outputBackpressure: OutputBackpressureTracker;

	private readonly platform: NodeJS.Platform;
	private readonly resizeSignalSource: ResizeSignalSource;
	readonly alternateScreen: boolean;

	constructor(
		private readonly streams: TtyStreams,
		options: StreamTerminalOptions = {},
	) {
		this.platform = options.platform ?? process.platform;
		this.resizeSignalSource = options.resizeSignalSource ?? process;
		this.alternateScreen = options.alternateScreen ?? false;
		this.outputBackpressure = new OutputBackpressureTracker(streams.output);
	}

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	get nativeScrollback(): boolean {
		return !this.alternateScreen;
	}

	get outputBackpressured(): boolean {
		return this.outputBackpressure.blocked;
	}

	onOutputDrain(listener: () => void): () => void {
		return this.outputBackpressure.subscribe(listener);
	}

	get columns(): number {
		return this.windowSize()?.[0] || this.streams.output.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return this.windowSize()?.[1] || this.streams.output.rows || Number(process.env.LINES) || 24;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		this.wasRaw = this.streams.input.isRaw || false;
		if (this.streams.input.setRawMode) {
			this.streams.input.setRawMode(true);
		}
		this.streams.input.setEncoding("utf8");
		this.streams.input.resume();
		if (this.alternateScreen) this.write("\x1b[?1049h");
		this.write("\x1b[?2004h");
		this.streams.output.on("resize", this.resizeHandler);
		if (this.platform !== "win32") {
			this.sigwinchHandler = () => this.resizeHandler?.();
			this.resizeSignalSource.on("SIGWINCH", this.sigwinchHandler);
		}
		this.stdinBuffer = new StdinBuffer({ timeout: 10 });
		this.stdinBuffer.on("data", (sequence) => {
			this.inputHandler?.(normalizeAppleTerminalInput(sequence, sequence === "\r" && isAppleTerminalSession(), false));
		});
		this.stdinBuffer.on("paste", (content) => {
			this.inputHandler?.(`\x1b[200~${content}\x1b[201~`);
		});
		this.stdinDataHandler = (data: string) => this.stdinBuffer?.process(data);
		this.streams.input.on("data", this.stdinDataHandler);
		setKittyProtocolActive(false);
	}

	stop(): void {
		this.write("\x1b[?1006l\x1b[?1000l");
		this.write("\x1b[?2004l");
		this.stdinBuffer?.destroy();
		this.stdinBuffer = undefined;
		if (this.stdinDataHandler) {
			this.streams.input.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		if (this.resizeHandler) {
			this.streams.output.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}
		if (this.sigwinchHandler) {
			this.resizeSignalSource.removeListener("SIGWINCH", this.sigwinchHandler);
			this.sigwinchHandler = undefined;
		}
		this.inputHandler = undefined;
		this.streams.input.pause();
		if (this.streams.input.setRawMode) {
			this.streams.input.setRawMode(this.wasRaw);
		}
		if (this.alternateScreen) this.write("\x1b[?1049l");
	}

	private windowSize(): [number, number] | undefined {
		try {
			const size = [0, 0];
			const handle = (this.streams.output as TtyWriteStreamWithHandle)._handle;
			if (handle?.getWindowSize(size) === 0) {
				const [columns = 0, rows = 0] = size;
				if (columns > 0 && rows > 0) return [columns, rows];
			}
		} catch {
			// Fall through to the public cached dimensions for other Node runtimes.
		}
		try {
			const [columns, rows] = this.streams.output.getWindowSize();
			if (columns > 0 && rows > 0) return [columns, rows];
		} catch {
			// Fall back to the stream's cached dimensions below.
		}
		return undefined;
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;
		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};
		this.streams.input.on("data", onData);
		const endTime = Date.now() + maxMs;
		try {
			while (Date.now() < endTime && Date.now() - lastDataTime < idleMs) {
				await new Promise((resolve) => setTimeout(resolve, idleMs));
			}
		} finally {
			this.streams.input.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	write(data: string): void {
		this.outputBackpressure.observeWrite(this.streams.output.write(data));
	}

	moveBy(lines: number): void {
		if (lines > 0) this.write(`\x1b[${lines}B`);
		if (lines < 0) this.write(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.write("\x1b[J");
	}

	clearScreen(): void {
		// Keep the host terminal scrollback intact. The renderer updates the
		// working area incrementally instead of clearing the screen.
	}

	setTitle(title: string): void {
		this.write(`\x1b]0;${title}\x07`);
	}

	setProgress(_active: boolean): void {}
}
