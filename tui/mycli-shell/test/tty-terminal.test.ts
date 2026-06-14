import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type tty from "node:tty";
import { StreamTerminal, type TtyStreams } from "../src/adapters/tty-terminal.ts";

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
	output = "";

	write(data: string): boolean {
		this.output += data;
		return true;
	}
}

test("stream terminal enters and leaves alternate screen around lifecycle", () => {
	const input = new FakeInput();
	const output = new FakeOutput();
	const terminal = new StreamTerminal({
		input: input as unknown as tty.ReadStream,
		output: output as unknown as tty.WriteStream,
		close: () => {},
	} satisfies TtyStreams);

	terminal.start(() => {}, () => {});
	terminal.stop();

	assert.match(output.output, /^\x1b\[\?1049h\x1b\[2J\x1b\[H/);
	assert.match(output.output, /\x1b\[\?2004h/);
	assert.match(output.output, /\x1b\[\?1000h\x1b\[\?1006h/);
	assert.match(output.output, /\x1b\[\?1006l\x1b\[\?1000l/);
	assert.match(output.output, /\x1b\[\?2004l/);
	assert.match(output.output, /\x1b\[\?1049l$/);
	assert.equal(input.resumed, true);
	assert.equal(input.paused, true);
	assert.equal(input.isRaw, false);
});
