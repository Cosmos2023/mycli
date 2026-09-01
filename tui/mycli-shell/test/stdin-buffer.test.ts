import assert from "node:assert/strict";
import test from "node:test";

import { StdinBuffer } from "../src/tui-core/stdin-buffer.ts";

test("stdin buffer emits inline bracketed paste and trailing input", () => {
	const buffer = new StdinBuffer();
	const pastes: string[] = [];
	const data: string[] = [];
	buffer.on("paste", (value) => pastes.push(value));
	buffer.on("data", (value) => data.push(value));

	buffer.process("\x1b[200~hello\nworld\x1b[201~x");

	assert.deepEqual(pastes, ["hello\nworld"]);
	assert.equal(data.join(""), "x");
});

test("stdin buffer completes bracketed paste split across chunks", () => {
	const buffer = new StdinBuffer();
	const pastes: string[] = [];
	buffer.on("paste", (value) => pastes.push(value));

	buffer.process("\x1b[200~hello");
	buffer.process(" world\x1b[201~");

	assert.deepEqual(pastes, ["hello world"]);
});

test("stdin buffer preserves CJK paste when bracket markers arrive in bursts", () => {
	const buffer = new StdinBuffer();
	const pastes: string[] = [];
	const data: string[] = [];
	buffer.on("paste", (value) => pastes.push(value));
	buffer.on("data", (value) => data.push(value));

	for (const chunk of ["\x1b[20", "0~北京", "输入\n", "第二行\x1b[20", "1~", "x"]) {
		buffer.process(chunk);
	}

	assert.deepEqual(pastes, ["北京输入\n第二行"]);
	assert.equal(data.join(""), "x");
});
