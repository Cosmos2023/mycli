import assert from "node:assert/strict";
import test from "node:test";
import { TerminalOutputNormalizer } from "../../src/index.ts";

test("split UTF-8 bytes decode one character without replacement", () => {
	const output = new TerminalOutputNormalizer();
	const bytes = new TextEncoder().encode("中");
	assert.deepEqual(output.push(bytes.subarray(0, 2)), { text: "", replacementCount: 0 });
	assert.deepEqual(output.push(bytes.subarray(2)), { text: "中", replacementCount: 0 });
	assert.deepEqual(output.finish(), { text: "", replacementCount: 0 });
});

test("Windows console code page output falls back instead of mojibake", () => {
	const output = new TerminalOutputNormalizer({ fallbackEncoding: "gbk" });
	const bytes = Uint8Array.from([0xbe, 0xdc, 0xbe, 0xf8, 0xb7, 0xc3, 0xce, 0xca, 0xa1, 0xa3]);
	const chunk = output.push(bytes);
	assert.equal(chunk.text, "拒绝访问。");
	assert.equal(chunk.replacementCount, 0);
	assert.equal(chunk.encoding, "fallback");
	assert.deepEqual(output.finish(), { text: "", replacementCount: 0, encoding: "fallback" });
});

test("carriage-return progress becomes append-only lines", () => {
	const output = new TerminalOutputNormalizer();
	assert.deepEqual(output.push("step 1\rstep 2\r\nfinished"), {
		text: "step 1\nstep 2\nfinished",
		replacementCount: 0,
	});
	assert.deepEqual(output.push("\r"), { text: "", replacementCount: 0 });
	assert.deepEqual(output.finish(), { text: "\n", replacementCount: 0 });
});

test("terminal styling and string controls are removed across chunks", () => {
	const output = new TerminalOutputNormalizer();
	assert.deepEqual(output.push("\x1b[31mred\x1b[0m:"), {
		text: "red:",
		replacementCount: 0,
	});
	assert.deepEqual(output.push("\x1b]52;c;sec"), { text: "", replacementCount: 0 });
	assert.deepEqual(output.push("ret\x1b\\safe\x1bPprivate"), {
		text: "safe",
		replacementCount: 0,
	});
	assert.deepEqual(output.push(" payload\x1b\\done"), {
		text: "done",
		replacementCount: 0,
	});
	assert.deepEqual(output.finish(), { text: "", replacementCount: 0 });
});

test("invalid and incomplete UTF-8 report replacement characters", () => {
	const invalid = new TerminalOutputNormalizer();
	assert.deepEqual(invalid.push(Uint8Array.of(0xff)), {
		text: "�",
		replacementCount: 1,
	});

	const incomplete = new TerminalOutputNormalizer();
	assert.deepEqual(incomplete.push(Uint8Array.of(0xe4)), {
		text: "",
		replacementCount: 0,
	});
	assert.deepEqual(incomplete.finish(), {
		text: "�",
		replacementCount: 1,
	});
	assert.deepEqual(incomplete.finish(), { text: "", replacementCount: 0 });
	assert.throws(() => incomplete.push("late"), /already finished/u);
});
