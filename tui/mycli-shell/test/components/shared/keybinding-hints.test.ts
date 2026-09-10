import assert from "node:assert/strict";
import test from "node:test";

import { createMycliKeybindings } from "../../../src/interaction/keybindings.ts";
import { formatKeyText, keyHint } from "../../../src/components/shared/keybinding-hints.ts";
import { setKeybindings } from "../../../src/tui-core/keybindings.ts";

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

test("visible hints use the effective binding instead of a hard-coded default", () => {
	const customized = createMycliKeybindings({
		"app.help": ["ctrl+h"],
	});
	setKeybindings(customized);
	try {
		assert.match(keyHint("app.help", "help").replace(/\x1b\[[0-9;]*m/gu, ""), /^ctrl\+h help$/u);
	} finally {
		setKeybindings(createMycliKeybindings());
	}
});
