import assert from "node:assert/strict";
import test from "node:test";

import { WebSearchComponent } from "../src/components/web-search.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

test("web search renders distinct running and completed rows", () => {
	const running = new WebSearchComponent({
		id: "web-search:ws-1",
		callId: "ws-1",
		status: "running",
		action: "other",
	});
	const completed = new WebSearchComponent({
		id: "web-search:ws-1",
		callId: "ws-1",
		status: "completed",
		action: "search",
		detail: "mycli hosted search",
	});

	assert.equal(stripAnsi(running.render(80).join("\n")), "\n⠋ Searching the web");
	assert.equal(
		stripAnsi(completed.render(80).join("\n")),
		"\n• Searched the web for mycli hosted search",
	);
});

test("web search rows remain width safe", () => {
	const component = new WebSearchComponent({
		id: "web-search:ws-1",
		callId: "ws-1",
		status: "completed",
		action: "search",
		detail: "非常长的搜索查询".repeat(20),
	});

	for (const line of component.render(24)) {
		assert.ok(visibleWidth(line) <= 24, stripAnsi(line));
	}
});
