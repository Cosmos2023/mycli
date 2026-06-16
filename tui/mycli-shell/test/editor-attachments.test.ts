import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDroppedFilePaste } from "../src/tui-core/components/editor.ts";

test("editor normalizes pasted workspace file paths into @ references", () => {
	const text = normalizeDroppedFilePaste("/repo/src/app.ts", { cwd: "/repo" });

	assert.equal(text, "@src/app.ts");
});

test("editor preserves spaces by quoting pasted workspace file references", () => {
	const text = normalizeDroppedFilePaste("/repo/docs/My Plan.md", { cwd: "/repo" });

	assert.equal(text, '@"docs/My Plan.md"');
});

test("editor normalizes file url drops into @ references", () => {
	const text = normalizeDroppedFilePaste("file:///repo/docs/notes.md", { cwd: "/repo" });

	assert.equal(text, "@docs/notes.md");
});

test("editor keeps multi-item and outside-workspace pastes as plain text", () => {
	assert.equal(normalizeDroppedFilePaste("/tmp/outside.md", { cwd: "/repo" }), "/tmp/outside.md");
	assert.equal(normalizeDroppedFilePaste("/repo/a.md\n/repo/b.md", { cwd: "/repo" }), "/repo/a.md\n/repo/b.md");
});
