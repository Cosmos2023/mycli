import assert from "node:assert/strict";
import test from "node:test";
import { formatKeyText } from "../src/components/keybinding-hints.ts";

test("macOS renders alt as option", () => {
	assert.equal(formatKeyText("alt+up/ctrl+alt+x", "darwin"), "option+up/ctrl+option+x");
});

test("Linux and Windows keep alt labels", () => {
	assert.equal(formatKeyText("alt+up", "linux"), "alt+up");
	assert.equal(formatKeyText("alt+up", "win32"), "alt+up");
});
