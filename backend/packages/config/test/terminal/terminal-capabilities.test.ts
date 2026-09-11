import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_SHELL_SETTINGS,
	detectTerminalCapabilities,
	resolveTerminalCapabilities,
} from "../../src/index.ts";

test("terminal capability detection is deterministic and respects no-color and ASCII boundaries", () => {
	assert.deepEqual(detectTerminalCapabilities({ TERM: "xterm-256color", LANG: "en_US.UTF-8" }, "linux"), {
		colorMode: "256",
		colorForcedOff: false,
		glyphMode: "unicode",
		terminalKind: "standard",
	});
	assert.deepEqual(detectTerminalCapabilities({ TERM: "dumb", COLORTERM: "truecolor" }, "linux"), {
		colorMode: "none",
		colorForcedOff: true,
		glyphMode: "ascii",
		terminalKind: "dumb",
	});
	assert.equal(detectTerminalCapabilities({ WT_SESSION: "session" }, "win32").colorMode, "truecolor");
	const noColor = detectTerminalCapabilities({ NO_COLOR: "", COLORTERM: "truecolor" }, "linux");
	assert.equal(noColor.colorMode, "none");
	assert.equal(noColor.colorForcedOff, true);
});

test("terminal preferences resolve semantic color, glyph, and motion behavior", () => {
	const detected = detectTerminalCapabilities({ TERM: "dumb" }, "linux");
	const capabilities = resolveTerminalCapabilities({
		...DEFAULT_SHELL_SETTINGS,
		color_mode: "truecolor",
		glyph_mode: "unicode",
		reduced_motion: true,
		high_contrast: true,
	}, detected);
	assert.equal(capabilities.colorMode, "none");
	assert.equal(capabilities.colorForcedOff, true);
	assert.equal(capabilities.glyphMode, "unicode");
	assert.equal(capabilities.progressVisible, true);
	assert.equal(capabilities.progressAnimated, false);
	assert.equal(capabilities.highContrast, true);
	assert.deepEqual(capabilities.guidance, []);

	const automatic = resolveTerminalCapabilities(DEFAULT_SHELL_SETTINGS, detected);
	assert.deepEqual(automatic.guidance, [
		"Terminal color is unavailable; using no-color output.",
		"Unicode glyph support is unavailable; using ASCII indicators.",
	]);
});
