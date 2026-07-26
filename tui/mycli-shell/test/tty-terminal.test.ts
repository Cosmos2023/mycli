import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type tty from "node:tty";
import {
	openTtyStreams,
	StreamTerminal,
	TtyOpenError,
	type TtyStreams,
} from "../src/adapters/tty-terminal.ts";

class FakeInput extends EventEmitter {
	isRaw = false;
	encoding = "";
	resumed = false;
	paused = false;

	setRawMode(enabled: boolean): void {
		this.isRaw = enabled;
	}

	setEncoding(encoding: BufferEncoding): void {
		this.encoding = encoding;
	}

	resume(): void {
		this.resumed = true;
	}

	pause(): void {
		this.paused = true;
	}
}

class FakeOutput extends EventEmitter {
	columns = 100;
	rows = 40;
	windowColumns = 100;
	windowRows = 40;
	output = "";
	_handle = {
		getWindowSize: (size: number[]) => {
			size[0] = this.windowColumns;
			size[1] = this.windowRows;
			return 0;
		},
	};

	write(data: string): boolean {
		this.output += data;
		return true;
	}

	getWindowSize(): [number, number] {
		return [this.columns, this.rows];
	}
}

test("stream terminal uses inline native scrollback by default without mouse capture", () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const terminal = new StreamTerminal({
		input: input as unknown as tty.ReadStream,
		output: output as unknown as tty.WriteStream,
		close: () => {},
	} satisfies TtyStreams);

	terminal.start(() => {}, () => {});
	terminal.clearScreen();
	terminal.stop();

	assert.match(output.output, /\x1b\[\?2004h/);
	assert.doesNotMatch(output.output, /\x1b\[\?1049[hl]/);
	assert.doesNotMatch(output.output, /\x1b\[2J\x1b\[H/);
	assert.doesNotMatch(output.output, /\x1b\[3J/);
	assert.doesNotMatch(output.output, /\x1b\[\?(1000|1002|1003|1006)h/);
	assert.match(output.output, /\x1b\[\?1006l\x1b\[\?1000l/);
	assert.match(output.output, /\x1b\[\?2004l/);
	assert.equal(terminal.nativeScrollback, true);
	assert.equal(input.resumed, true);
	assert.equal(input.paused, true);
	assert.equal(input.isRaw, false);
});

test("stream terminal can use alternate screen explicitly", () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const terminal = new StreamTerminal({
		input: input as unknown as tty.ReadStream,
		output: output as unknown as tty.WriteStream,
		close: () => {},
	} satisfies TtyStreams, { alternateScreen: true });

	terminal.start(() => {}, () => {});
	terminal.stop();

	assert.match(output.output, /\x1b\[\?1049h/);
	assert.match(output.output, /\x1b\[\?1049l/);
	assert.equal(terminal.nativeScrollback, false);
});

test("stream terminal refreshes dev tty dimensions on SIGWINCH", () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const resizeSignals = new EventEmitter();
	const terminal = new StreamTerminal({
		input: input as unknown as tty.ReadStream,
		output: output as unknown as tty.WriteStream,
		close: () => {},
	} satisfies TtyStreams, {
		platform: "darwin",
		resizeSignalSource: resizeSignals,
	});
	let resizeCalls = 0;

	terminal.start(() => {}, () => {
		resizeCalls += 1;
	});
	try {
		output.windowColumns = 132;
		output.windowRows = 55;
		resizeSignals.emit("SIGWINCH");

		assert.equal(resizeCalls, 1);
		assert.equal(terminal.columns, 132);
		assert.equal(terminal.rows, 55);
	} finally {
		terminal.stop();
	}

	resizeSignals.emit("SIGWINCH");
	assert.equal(resizeCalls, 1);
});

test("Windows uses raw TTY stdio without opening /dev/tty", () => {
	const input = new FakeInput() as unknown as tty.ReadStream;
	const output = new FakeOutput() as unknown as tty.WriteStream;
	Object.assign(input, { isTTY: true });
	Object.assign(output, { isTTY: true });
	let openCalls = 0;

	const streams = openTtyStreams({
		platform: "win32",
		stdin: input,
		stdout: output,
		openSync: () => {
			openCalls += 1;
			throw new Error("must not open /dev/tty");
		},
	});

	assert.equal(streams.input, input);
	assert.equal(streams.output, output);
	assert.equal(openCalls, 0);
	streams.close();
});

test("Windows reports missing raw TTY capability without mentioning /dev/tty", () => {
	const input = new FakeInput() as unknown as tty.ReadStream;
	const output = new FakeOutput() as unknown as tty.WriteStream;
	Object.assign(input, { isTTY: false });
	Object.assign(output, { isTTY: true });

	assert.throws(
		() =>
			openTtyStreams({
				platform: "win32",
				stdin: input,
				stdout: output,
			}),
		(error: unknown) => {
			assert.ok(error instanceof TtyOpenError);
			assert.match(error.message, /interactive TTY with raw input support/i);
			assert.doesNotMatch(error.message, /\/dev\/tty/);
			return true;
		},
	);
});
