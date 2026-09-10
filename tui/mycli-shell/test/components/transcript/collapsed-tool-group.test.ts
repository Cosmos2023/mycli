import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	CollapsedToolGroupComponent,
} from "../../../src/components/transcript/collapsed-tool-group.ts";
import {
	type CollapsedToolGroupItem,
} from "../../../src/transcript/tool-group.ts";
import { visibleWidth } from "../../../src/tui-core/utils.ts";

test("mixed context groups stay running and report failed members", () => {
	const items: CollapsedToolGroupItem[] = [
		{ kind: "tool", tool: { id: "failed", name: "Read", args: "failed.txt", status: "error", errorPreview: "permission denied" } },
		{ kind: "tool", tool: { id: "running", name: "Read", args: "running.txt", status: "running" } },
	];
	const group = new CollapsedToolGroupComponent({ id: "group", items });
	for (const width of [28, 80]) {
		const lines = group.render(width).map(stripVTControlCharacters);
		const text = lines.join(" ").replace(/\s+/gu, " ");
		assert.match(text, /Exploring.*1 failed/u);
		assert.match(text, /Read failed\.txt \(failed\).*Read running\.txt/u);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	group.updateGroup({ id: "group", items: [items[0]!, { kind: "tool", tool: {
		id: "running", name: "Read", args: "running.txt", status: "success",
	} }] });
	const completed = stripVTControlCharacters(group.render(80).join("\n"));
	assert.match(completed, /Explored.*1 failed/u);
	assert.doesNotMatch(completed, /Running|Reading/u);
});

test("exploration groups coalesce consecutive reads, dedupe names, and retain all actions", () => {
	const items: CollapsedToolGroupItem[] = [
		...Array.from({ length: 6 }, (_, index): CollapsedToolGroupItem => ({
			kind: "tool", tool: { id: `read-${index}`, name: "Read", args: `src/file-${index}.ts`, status: "success" },
		})),
		{ kind: "tool", tool: { id: "duplicate", name: "read_file", args: "src/file-0.ts", status: "success" } },
		{ kind: "bash", bash: { id: "search", command: "rg -n -g '*.ts' approval src", status: "success", outputPreview: "matching source" } },
		{ kind: "bash", bash: { id: "list", command: "rg --files tests", status: "success", outputPreview: "tests/app.test.ts" } },
		{ kind: "tool", tool: { id: "later", name: "Read", args: "src/file-0.ts", status: "running", summaryPreview: "Lines 1-10 of 100" } },
	];
	const component = new CollapsedToolGroupComponent({ id: "group", items });
	const output = stripVTControlCharacters(component.render(120).join("\n"));
	assert.match(output, /Exploring/u);
	assert.match(output, /  └ Read file-0\.ts, file-1\.ts, file-2\.ts, file-3\.ts, file-4\.ts, file-5\.ts/u);
	assert.match(output, /    Search approval in src\n    List tests\n    Read file-0\.ts/u);
	assert.equal(output.match(/file-0\.ts/gu)?.length, 2);
	assert.doesNotMatch(output, /matching source|--glob|Lines 1|more|to expand/u);
	for (const width of [12, 24, 40, 80]) {
		const lines = component.render(width).map(stripVTControlCharacters);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.map((line) => line.trim()).join(""), /file-5\.ts/u);
	}
});

test("a successful retry cannot hide a failed or cancelled read of the same file", () => {
	const items: CollapsedToolGroupItem[] = (["error", "cancelled", "success"] as const).map((status, index) => ({
		kind: "tool", tool: { id: `read-${index}`, name: "Read", args: "src/app.ts", status },
	}));
	const output = stripVTControlCharacters(new CollapsedToolGroupComponent({ id: "group", items }).render(100).join("\n"));
	assert.match(output, /Explored.*1 failed, 1 cancelled/u);
	assert.match(output, /Read app\.ts \(failed\)/u);
	assert.match(output, /Read app\.ts \(cancelled\)/u);
	assert.equal(output.match(/Read app\.ts/gu)?.length, 3);
});
