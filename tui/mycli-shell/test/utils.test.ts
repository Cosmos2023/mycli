import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "../src/tui-core/utils.ts";

test("visible width ignores OSC and APC string control sequences", () => {
	const hyperlink = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
	const applicationCommand = "\x1b_cursor-marker\x1b\\text";

	assert.equal(visibleWidth(hyperlink), 4);
	assert.equal(visibleWidth(applicationCommand), 4);
});
