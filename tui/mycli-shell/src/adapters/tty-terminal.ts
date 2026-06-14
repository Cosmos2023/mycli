import fs from "node:fs";
import tty from "node:tty";
import { normalizeAppleTerminalInput, isAppleTerminalSession, type Terminal } from "../tui-core/terminal.ts";
import { setKittyProtocolActive } from "../tui-core/keys.ts";
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

export function openTtyStreams(): TtyStreams {
	let inputFd: number;
	let outputFd: number;
	try {
		inputFd = fs.openSync("/dev/tty", "r");
		outputFd = fs.openSync("/dev/tty", "w");
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
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private _kittyProtocolActive = false;

	constructor(private readonly streams: TtyStreams) {}

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	get nativeScrollback(): boolean {
		return true;
	}

	get columns(): number {
		return this.streams.output.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return this.streams.output.rows || Number(process.env.LINES) || 24;
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
		this.write("\x1b[2J\x1b[H");
		this.write("\x1b[?2004h");
		this.streams.output.on("resize", this.resizeHandler);
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
		this.inputHandler = undefined;
		this.streams.input.pause();
		if (this.streams.input.setRawMode) {
			this.streams.input.setRawMode(this.wasRaw);
		}
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
		this.streams.output.write(data);
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
		this.write("\x1b[2J\x1b[H");
	}

	setTitle(title: string): void {
		this.write(`\x1b]0;${title}\x07`);
	}

	setProgress(_active: boolean): void {}
}
