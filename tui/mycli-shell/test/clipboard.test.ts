import assert from "node:assert/strict";
import test from "node:test";
import { copyText } from "../src/adapters/clipboard.ts";

type SpawnCall = {
	command: string;
	args: readonly string[];
	input: string;
};

function spawnRecorder(statuses: ReadonlyMap<string, number | Error>) {
	const calls: SpawnCall[] = [];
	const spawnSync = (command: string, args: readonly string[] = [], options: { input?: string } = {}) => {
		calls.push({ command, args, input: options.input ?? "" });
		const result = statuses.get(command) ?? 0;
		if (result instanceof Error) throw result;
		return { status: result };
	};
	return { calls, spawnSync };
}

test("macOS copies through pbcopy", () => {
	const recorder = spawnRecorder(new Map());
	assert.equal(copyText("hello", { platform: "darwin", spawnSync: recorder.spawnSync }), true);
	assert.deepEqual(recorder.calls, [{ command: "pbcopy", args: [], input: "hello" }]);
});

test("Windows copies through clip.exe", () => {
	const recorder = spawnRecorder(new Map());
	assert.equal(copyText("hello", { platform: "win32", spawnSync: recorder.spawnSync }), true);
	assert.deepEqual(recorder.calls, [{ command: "clip.exe", args: [], input: "hello" }]);
});

test("Linux falls back from wl-copy to xclip and xsel", () => {
	const recorder = spawnRecorder(
		new Map<string, number | Error>([
			["wl-copy", new Error("missing")],
			["xclip", 1],
			["xsel", 0],
		]),
	);
	assert.equal(copyText("hello", { platform: "linux", spawnSync: recorder.spawnSync }), true);
	assert.deepEqual(recorder.calls, [
		{ command: "wl-copy", args: [], input: "hello" },
		{ command: "xclip", args: ["-selection", "clipboard"], input: "hello" },
		{ command: "xsel", args: ["--clipboard", "--input"], input: "hello" },
	]);
});

test("clipboard failure degrades without throwing", () => {
	const recorder = spawnRecorder(new Map([["clip.exe", new Error("missing")]]));
	assert.equal(copyText("hello", { platform: "win32", spawnSync: recorder.spawnSync }), false);
});
