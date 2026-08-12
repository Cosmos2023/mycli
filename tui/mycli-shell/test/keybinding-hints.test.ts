import assert from "node:assert/strict";
import test from "node:test";

import { createMycliKeybindings } from "../src/keybindings.ts";
import { formatKeyText } from "../src/components/keybinding-hints.ts";

test("default app and widget keybindings have no same-context conflicts", () => {
	const keybindings = createMycliKeybindings();
	assert.deepEqual(keybindings.getConflicts(), []);

	keybindings.setUserBindings({
		"app.help": "ctrl+p",
		"app.commandPalette": "ctrl+p",
	});
	assert.deepEqual(keybindings.getConflicts(), [{
		key: "ctrl+p",
		context: "app",
		keybindings: ["app.commandPalette", "app.help"],
	}]);
});

test("macOS renders alt as option", () => {
	assert.equal(formatKeyText("alt+up/ctrl+alt+x", "darwin"), "option+up/ctrl+option+x");
});

test("Linux and Windows keep alt labels", () => {
	assert.equal(formatKeyText("alt+up", "linux"), "alt+up");
	assert.equal(formatKeyText("alt+up", "win32"), "alt+up");
});
