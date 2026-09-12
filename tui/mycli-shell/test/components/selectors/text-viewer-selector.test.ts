import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { TextViewerSelectorComponent } from "../../../src/components/selectors/text-viewer-selector.ts";
import { visibleWidth } from "../../../src/tui-core/utils.ts";

test("diff viewer reflows wide text within the viewport and strips terminal controls", async () => {
	const viewer = new TextViewerSelectorComponent({
		title: "Git changes", diff: true, maxHeight: () => 8, onCancel() {},
		load: async () => "+新增内容".repeat(8) + "\n-old line\u001b[2J\n unchanged",
	});
	try {
		await setImmediate();
		for (const width of [60, 16, 5, 1, 40]) {
			const rows = viewer.render(width);
			assert.ok(rows.length <= 8);
			assert.ok(rows.every((row) => visibleWidth(row) <= width));
			assert.ok(rows.every((row) => !row.includes("\u001b[2J")));
		}
		viewer.handleInput("\u001b[B");
		viewer.handleInput("\u001b[4~");
		assert.match(stripVTControlCharacters(viewer.render(40).join("\n")), /unchanged/);
	} finally { viewer.dispose(); }
});

test("closing or refreshing a viewer cancels old loads and ignores late results", async () => {
	const pending = Array.from({ length: 3 }, () => Promise.withResolvers<string>());
	const signals: AbortSignal[] = [];
	let renders = 0;
	const viewer = new TextViewerSelectorComponent({
		title: "Preview", onCancel() {}, onRender() { renders++; },
		load: (signal) => { signals.push(signal); return pending[signals.length - 1]!.promise; },
	});
	try {
		viewer.handleInput("\u0012");
		assert.equal(signals[0]?.aborted, true);
		pending[1]!.resolve("Current preview");
		await setImmediate();
		pending[0]!.resolve("Stale preview");
		await setImmediate();
		assert.match(viewer.render(60).join("\n"), /Current preview/);
		assert.doesNotMatch(viewer.render(60).join("\n"), /Stale preview/);
		viewer.handleInput("\u0012");
		viewer.dispose();
		const before = renders;
		assert.equal(signals[2]?.aborted, true);
		pending[2]!.resolve("Dismissed preview");
		await setImmediate();
		assert.equal(renders, before);
		assert.doesNotMatch(viewer.render(60).join("\n"), /Dismissed preview/);
	} finally { viewer.dispose(); }
});
