import assert from "node:assert/strict";
import test from "node:test";
import {
	normalizeTuiKeySpec,
	TUI_KEYMAP_ACTIONS,
	tuiKeymapAction,
	tuiKeymapActionForConfig,
	tuiKeymapConfigPath,
} from "../src/index.ts";

test("canonical TUI keymap actions have unique ids, paths, and valid defaults", () => {
	const ids = new Set<string>();
	const paths = new Set<string>();
	for (const action of TUI_KEYMAP_ACTIONS) {
		assert.equal(ids.has(action.id), false, action.id);
		assert.equal(paths.has(tuiKeymapConfigPath(action)), false, tuiKeymapConfigPath(action));
		assert.ok(action.description.trim(), action.id);
		assert.ok(action.defaultKeys.length > 0, action.id);
		for (const key of action.defaultKeys) assert.equal(normalizeTuiKeySpec(key), key, `${action.id}: ${key}`);
		ids.add(action.id);
		paths.add(tuiKeymapConfigPath(action));
		assert.equal(tuiKeymapAction(action.id)?.id, action.id);
		assert.equal(tuiKeymapActionForConfig(action.context, action.configKey)?.id, action.id);
	}
});

test("TUI key specs normalize aliases and modifier order while rejecting unusable values", () => {
	assert.equal(normalizeTuiKeySpec(" Esc "), "escape");
	assert.equal(normalizeTuiKeySpec("alt+CTRL+X"), "ctrl+alt+x");
	assert.equal(normalizeTuiKeySpec("return"), "enter");
	assert.equal(normalizeTuiKeySpec("pageup"), "pageUp");
	assert.equal(normalizeTuiKeySpec("ctrl+ctrl+x"), undefined);
	assert.equal(normalizeTuiKeySpec("ctrl+escape"), undefined);
	assert.equal(normalizeTuiKeySpec("ctrl+"), undefined);
	assert.equal(normalizeTuiKeySpec("mouse1"), undefined);
});
