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
		// The goal owns its own row; the shell counter and extension summary follow it.
		assert.equal(lines.length, 4);
		assert.match(lines[1]!, /Pursuing goal/);
		assert.doesNotMatch(lines[1]!, /Tasks/);
		assert.match(lines[3]!, /\+\d+ more$/);
		if (width >= 40) assert.match(lines[2]!, /2 shells/);
		if (width >= 80) assert.match(lines[2]!, /\/ps/);
		assert.ok(lines.every((line) => visibleWidth(line) < width));
	}
	const longExtension = new WorkStatusComponent({ cwd: "/repo", extensionStatuses: ["x".repeat(1000), "second"] });
	assert.match(stripAnsi(longExtension.render(24).at(-1)!), /\+1 more$/);
	assert.deepEqual(new WorkStatusComponent({ cwd: "/repo", extensionStatuses: ["", "\n\t"] }).render(80), []);
});

test("goal summaries follow Codex wording and keep the objective while it fits", () => {
	// Wide enough for the objective; narrower rows drop it, then the usage, then the qualifier.
	assert.equal(stripAnsi(renderGoalStatus(goal, 200)), "Pursuing goal (1.25K / 50K) · 修复文档渲染");
	assert.equal(stripAnsi(renderGoalStatus(goal, 40)), "Pursuing goal (1.25K / 50K)");
	assert.equal(stripAnsi(renderGoalStatus(goal, 24)), "Pursuing goal");
	assert.match(stripAnsi(renderGoalStatus({ ...goal, usage_incomplete: true }, 60)), /1\.25K\+ \/ 50K/);

	for (const [status, text] of [
		["paused", "Goal paused (/goal resume) · 修复文档渲染"],
		["blocked", "Goal stalled (/goal resume) · 修复文档渲染"],
		["usage_limited", "Goal hit usage limits (/goal resume) · 修复文档渲染"],
	] as const) {
		assert.equal(stripAnsi(renderGoalStatus({ ...goal, status }, 200)), text);
	}
	assert.equal(
		stripAnsi(renderGoalStatus({ ...goal, status: "budget_limited" }, 200)),
		"Goal unmet (1.25K / 50K tokens) · 修复文档渲染",
	);
	assert.equal(
		stripAnsi(renderGoalStatus({ ...goal, status: "complete" }, 200)),
		"Goal achieved (1.25K tokens) · 修复文档渲染",
	);
	// Codex reports elapsed time while a goal has no token budget to report.
	assert.equal(
		stripAnsi(renderGoalStatus({ ...goal, token_budget: null, elapsed_ms: 90_000 }, 200)),
		"Pursuing goal (1m) · 修复文档渲染",
	);
	assert.equal(
		stripAnsi(renderGoalStatus({ ...goal, token_budget: null, elapsed_ms: 90_000, status: "complete" }, 24)),
		"Goal achieved (1m)",
	);
	assert.doesNotMatch(stripAnsi(renderGoalStatus(goal, 160)), /continuations/);
});

test("the goal clock advances only inside a running turn", () => {
	const idle = { ...goal, token_budget: null, elapsed_ms: 0 };
	// Snapshot arrived 1s ago, the turn started 3s ago: only the 7s after the turn started counts.
	assert.equal(
		stripAnsi(renderGoalStatus(idle, 200, { now: 10_000, observedAtMs: 1_000, turnStartedAtMs: 3_000 })),
		"Pursuing goal (7s) · 修复文档渲染",
	);
	// A snapshot that arrives mid-turn restarts the increment from its own moment.
	assert.equal(
		stripAnsi(renderGoalStatus(idle, 200, { now: 10_000, observedAtMs: 8_000, turnStartedAtMs: 3_000 })),
		"Pursuing goal (2s) · 修复文档渲染",
	);
	// Without a running turn the snapshot is authoritative.
	assert.equal(
		stripAnsi(renderGoalStatus(idle, 200, { now: 10_000, observedAtMs: 1_000, turnStartedAtMs: null })),
		"Pursuing goal (0s) · 修复文档渲染",
	);
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
		// The objective is user text; keep it ASCII so this case only proves the footer itself is.
		const data: MycliShellFooterData = { cwd: "/repo", model: "model", collaborationMode: "plan", contextPercent: 92, goal: { ...goal, objective: "fix docs rendering" }, backgroundShellCount: 2 };
		const lines = [...new WorkStatusComponent(data).render(100), ...new FooterComponent(data).render(100)];
		const output = lines.join("\n");
		assert.match(output, /Pursuing goal/);
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
