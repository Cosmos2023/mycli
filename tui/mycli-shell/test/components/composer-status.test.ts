import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { parseSessionGoal } from "@mycli/contracts";
import { FooterComponent } from "../../src/components/composer/footer.ts";
import { renderGoalStatus } from "../../src/components/composer/goal-status.ts";
import { WorkStatusComponent } from "../../src/components/composer/work-status.ts";
import { StatusMessageComponent } from "../../src/components/composer/status-line.ts";
import type { MycliShellFooterData } from "../../src/model.ts";
import { visibleWidth } from "../../src/tui-core/utils.ts";
import { theme } from "../../src/theme/theme.ts";
import { setUiGlyphMode, uiGlyphMode } from "../../src/theme/terminal-style.ts";

const goal = parseSessionGoal({
	goal_id: "goal", revision: 1, objective: "修复文档渲染", status: "active",
	token_budget: 50000, tokens_used: 1250, elapsed_ms: 1000, rounds_started: 2, audit_turns: 3,
	created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z", stop_reason: null, usage_incomplete: false,
});

test("work summaries stay bounded and reserve room for omitted extension counts", () => {
	const work = new WorkStatusComponent({
		cwd: "/repo", goal, backgroundShellCount: 2, taskProgress: { completed: 2, total: 5 },
		extensionStatuses: ["Search ready", "Search ready", "", "   ", ...Array.from({ length: 20 }, (_, i) => `Extension ${i} ready`)],
	});
	for (const width of [24, 40, 80, 160]) {
		const lines = work.render(width).map(stripAnsi);
		assert.equal(lines.length, 3);
		assert.match(lines[1]!, /Goal active/);
		assert.doesNotMatch(lines[1]!, /Tasks/);
		assert.match(lines[2]!, /\+\d+ more$/);
		if (width >= 40) assert.match(lines[1]!, /2 shells/);
		if (width >= 80) assert.match(lines[1]!, /\/ps/);
		assert.ok(lines.every((line) => visibleWidth(line) < width));
	}
	const longExtension = new WorkStatusComponent({ cwd: "/repo", extensionStatuses: ["x".repeat(1000), "second"] });
	assert.match(stripAnsi(longExtension.render(24).at(-1)!), /\+1 more$/);
	assert.deepEqual(new WorkStatusComponent({ cwd: "/repo", extensionStatuses: ["", "\n\t"] }).render(80), []);
});

test("goal summaries keep an appropriate control and preserve incomplete usage", () => {
	assert.match(stripAnsi(renderGoalStatus(goal, 100)), /1250\/50000 tokens.*\/goal pause/);
	for (const status of ["paused", "blocked", "usage_limited"] as const) {
		assert.match(stripAnsi(renderGoalStatus({ ...goal, status }, 100)), /\/goal resume$/);
	}
	for (const status of ["budget_limited", "complete"] as const) {
		assert.match(stripAnsi(renderGoalStatus({ ...goal, status }, 100)), /\/goal$/);
	}
	assert.match(stripAnsi(renderGoalStatus({ ...goal, usage_incomplete: true }, 100)), /1250\+\/50000 tokens/);
	assert.equal(stripAnsi(renderGoalStatus(goal, 28)), "Goal active · /goal pause");
	assert.equal(stripAnsi(renderGoalStatus(goal, 14)), "Goal active");
	assert.doesNotMatch(stripAnsi(renderGoalStatus(goal, 160)), /continuations/);
});

test("footer reserves mode and context before reasoning or a long model name", () => {
	const data: MycliShellFooterData = {
		cwd: "/repo", collaborationMode: "plan", trust: "unknown", model: "a-very-long-model-name", reasoningLevel: "xhigh", contextPercent: 95,
	};
	const narrow = new FooterComponent(data, { statusbarMode: "compact" }).render(40).map(stripAnsi);
	assert.equal(narrow.length, 1);
	assert.match(narrow[0]!, /trust\?.*plan.*95% ctx$/);
	assert.doesNotMatch(narrow[0]!, /xhigh/);
	assert.match(stripAnsi(new FooterComponent(data).render(20)[0]!), /trust\?.*plan/);
	const fallback = new FooterComponent({ cwd: "/repo" }, { statusbarMode: "compact" }).render(40).map(stripAnsi);
	assert.deepEqual(fallback, [" /repo"]);
});

test("composer metadata stays on physical rows with CJK paths and terminal controls", () => {
	for (const cwd of ["/很长的路径/用户项目", "C:\\Users\\developer\\very-long-workspace\\project", "~/work/project"]) {
		const data: MycliShellFooterData = {
			cwd, goal, sessionName: "修复输入框\n\t状态栏", gitBranch: "feature/状态\r\n栏",
			model: "model\x1b[2J-name", reasoningLevel: "high", contextPercent: 88.5, collaborationMode: "plan",
			backgroundShellCount: 12, taskProgress: { completed: 3, total: 7 },
			extensionStatuses: ["status\x1b]52;c;clipboard-payload\x07\twith\ncontrols", "second"],
		};
		for (const width of [0, 1, 2, 3, 8, 20, 40, 80, 160]) {
			for (const component of [new FooterComponent(data), new WorkStatusComponent(data)]) {
				const lines = component.render(width);
				if (width === 0) assert.deepEqual(lines, []);
				for (const line of lines) {
					assert.ok(visibleWidth(line) <= (width > 1 ? width - 1 : width));
					assert.doesNotMatch(stripAnsi(line), /[\r\n\t\x00-\x1f\x7f-\x9f]/u);
					assert.doesNotMatch(line, /clipboard-payload|\x1b\[2J/u);
				}
			}
		}
	}
});

test("composer status remains readable in ASCII without color", () => {
	const glyphMode = uiGlyphMode();
	const colorMode = theme.colorMode();
	try {
		setUiGlyphMode("ascii");
		theme.setColorMode("none");
		const data: MycliShellFooterData = { cwd: "/repo", model: "model", collaborationMode: "plan", contextPercent: 92, goal, backgroundShellCount: 2 };
		const lines = [...new WorkStatusComponent(data).render(100), ...new FooterComponent(data).render(100)];
		const output = lines.join("\n");
		assert.match(output, /Goal active.*\/goal pause/);
		assert.match(output, /plan.*model.*92% ctx/);
		assert.match(output, /2 shells.*\/ps/);
		assert.doesNotMatch(output, /\x1b|[^\x00-\x7f]/u);
	} finally {
		setUiGlyphMode(glyphMode);
		theme.setColorMode(colorMode);
	}
});

test("non-animated activity cannot wrap or inject additional status rows", () => {
	const status = new StatusMessageComponent("Waiting\nfor\x1b[2J input 很长的提示".repeat(5));
	for (const width of [8, 24, 40, 80]) {
		const lines = status.render(width);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]!) < width);
		assert.doesNotMatch(lines[0]!, /\n|\x1b\[2J/u);
	}
	assert.deepEqual(status.render(0), []);
});
