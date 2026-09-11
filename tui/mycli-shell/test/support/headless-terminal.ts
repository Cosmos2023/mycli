import { createRequire } from "node:module";
import type { IBufferCell, Terminal as XtermTerminal } from "@xterm/headless";
import type { Terminal } from "../../src/tui-core/terminal.ts";

const require = createRequire(import.meta.url);
const { Terminal: XtermHeadless } = require("@xterm/headless") as {
	Terminal: typeof import("@xterm/headless").Terminal;
};

export interface HeadlessTerminalOptions {
	columns?: number;
	rows?: number;
	scrollback?: number;
	nativeScrollback?: boolean;
	alternateScreen?: boolean;
}

/** A real ANSI terminal core for renderer integration tests. */
export class HeadlessTerminal implements Terminal {
	readonly kittyProtocolActive = false;
	readonly alternateScreen: boolean;
	nativeScrollback: boolean;
	readonly writes: string[] = [];
	private _outputBackpressured = false;
	private readonly outputDrainListeners = new Set<() => void>();

	private readonly emulator: XtermTerminal;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private writeTail: Promise<void> = Promise.resolve();

	constructor(options: HeadlessTerminalOptions = {}) {
		this.alternateScreen = options.alternateScreen ?? false;
		this.nativeScrollback = options.nativeScrollback ?? false;
		this.emulator = new XtermHeadless({
			cols: options.columns ?? 80,
			rows: options.rows ?? 24,
			scrollback: options.scrollback ?? 1_000,
			allowProposedApi: true,
			logLevel: "off",
		});
	}

	get columns(): number {
		return this.emulator.cols;
	}

	get rows(): number {
		return this.emulator.rows;
	}

	get outputBackpressured(): boolean {
		return this._outputBackpressured;
	}

	onOutputDrain(listener: () => void): () => void {
		this.outputDrainListeners.add(listener);
		return () => this.outputDrainListeners.delete(listener);
	}

	setOutputBackpressured(blocked: boolean): void {
		if (this._outputBackpressured === blocked) return;
		this._outputBackpressured = blocked;
		if (!blocked) {
			for (const listener of this.outputDrainListeners) listener();
		}
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
		this.writeTail = this.writeTail.then(() => new Promise<void>((resolve) => {
			this.emulator.write(data, resolve);
		}));
	}

	async flush(): Promise<void> {
		await this.writeTail;
	}

	resize(columns: number, rows: number): void {
		this.emulator.resize(columns, rows);
		this.resizeHandler?.();
	}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	scrollLines(lines: number): void {
		this.emulator.scrollLines(lines);
	}

	bufferLines(): string[] {
		const buffer = this.emulator.buffer.active;
		return Array.from({ length: buffer.length }, (_, row) =>
			buffer.getLine(row)?.translateToString(true) ?? "",
		);
	}

	visibleLines(): string[] {
		const buffer = this.emulator.buffer.active;
		return Array.from({ length: this.rows }, (_, row) =>
			buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
		);
	}

	visibleCell(row: number, column: number): IBufferCell | undefined {
		const buffer = this.emulator.buffer.active;
		return buffer.getLine(buffer.viewportY + row)?.getCell(column);
	}

	historyLines(): string[] {
		const buffer = this.emulator.buffer.normal;
		return Array.from({ length: buffer.baseY }, (_, row) =>
			buffer.getLine(row)?.translateToString(true) ?? "",
		);
	}

	cursorPosition(): { row: number; column: number } {
		const buffer = this.emulator.buffer.active;
		return { row: buffer.cursorY, column: buffer.cursorX };
	}

	moveBy(lines: number): void {
		if (lines < 0) this.write(`\x1b[${-lines}A`);
		if (lines > 0) this.write(`\x1b[${lines}B`);
	}

	hideCursor(): void {
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\r\x1b[2K");
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

	setProgress(): void {}

	dispose(): void {
		this.emulator.dispose();
	}
}
