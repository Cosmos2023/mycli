import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { ApprovalSelectorComponent } from "../../../src/components/selectors/approval-selector.ts";
import type { MycliShellPendingApproval } from "../../../src/model.ts";
import { theme, type ThemeColorMode, type ThemeName } from "../../../src/theme/theme.ts";
import { visibleWidth } from "../../../src/tui-core/utils.ts";
import { HeadlessTerminal } from "../../support/headless-terminal.ts";

function shellSelector(): ApprovalSelectorComponent {
	return new ApprovalSelectorComponent({
		approval: {
			decisionId: "styled-shell", toolName: "Shell", preview: "Generic policy preview",
			commandPreview: "node -e \"console.log('first  second', process.cwd())\"\n  printf '%s\\n' '\u4e2d\u6587'",
			reason: "This command requests broader permissions than currently allowed.",
			justification: "Run the requested workspace checks.",
			risk: "medium", riskReason: "Runs workspace scripts",
			persistentRulePreview: '["node", "-e"]',
			options: [
				{ choice: "approve_once", label: "Allow once" },
				{ choice: "reject", label: "Reject" },
				{ choice: "allow_session", label: "Allow for this session" },
				{ choice: "always_allow", label: "Always allow" },
			],
		},
		onSelect: () => undefined, onCancel: () => undefined,
		maxHeight: () => 24,
	});
}

function assertBackground(
	terminal: HeadlessTerminal,
	row: number,
	start: number,
	end: number,
	colored: boolean,
): void {
	assert.ok(row >= 0, "expected row to be visible");
	const reference = terminal.visibleCell(row, start);
	assert.ok(reference);
	assert.equal(reference.isBgDefault(), !colored);
	for (let column = start; column < end; column += 1) {
		const cell = terminal.visibleCell(row, column);
		assert.ok(cell);
		assert.equal(cell.getBgColorMode(), reference.getBgColorMode(), `row ${row}, column ${column}`);
		assert.equal(cell.getBgColor(), reference.getBgColor(), `row ${row}, column ${column}`);
	}
}

test("shell approval backgrounds fill wrapped previews and follow selection across terminal palettes", async (context) => {
	const previousName = theme.name();
	const previousMode = theme.colorMode();
	context.after(() => { theme.setName(previousName); theme.setColorMode(previousMode); });
	const palettes: readonly (readonly [ThemeName, ThemeColorMode])[] = [
		["dark", "truecolor"], ["light", "truecolor"], ["dark", "256"], ["light", "16"], ["dark", "none"],
	];
	for (const [name, mode] of palettes) {
		for (const width of [32, 40, 80, 120]) {
			theme.setName(name);
			theme.setColorMode(mode);
			const terminal = new HeadlessTerminal({ columns: width, rows: 30 });
			try {
				const selector = shellSelector();
				const lines = selector.render(width);
				assert.ok(lines.length <= 24);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				terminal.write(lines.join("\r\n"));
				await terminal.flush();
				const visible = terminal.visibleLines();
				const commandRow = visible.findIndex((line) => line.includes("$ node"));
				assertBackground(terminal, commandRow, 2, width - 2, mode !== "none");
				assert.equal(terminal.visibleCell(commandRow, 0)?.isBgDefault(), true);
				assert.equal(terminal.visibleCell(commandRow, width - 1)?.isBgDefault(), true);
				assertBackground(terminal, visible.findIndex((line) => line.includes("1. Allow once")), 0, width, mode !== "none");
				assertBackground(terminal, visible.findIndex((line) => line.includes("2. Reject")), 0, width, false);
				if (width >= 80) {
					assertBackground(terminal, visible.findIndex((line) => line.includes("printf")), 2, width - 2, mode !== "none");
					assert.match(visible.join("\n"), /first {2}second/u);
					assert.match(visible.join("\n"), /\u4e2d\u6587/u);
					assert.match(visible.join("\n"), /Reason: Run the requested workspace checks\./u);
					assert.doesNotMatch(visible.join("\n"), /Approval:|This command requests broader permissions/u);
				}
				selector.handleInput("j");
				const updated = selector.render(width);
				assert.equal(updated.length, lines.length);
				terminal.clearScreen();
				terminal.write(updated.join("\r\n"));
				await terminal.flush();
				const changed = terminal.visibleLines();
				assertBackground(terminal, changed.findIndex((line) => line.includes("1. Allow once")), 0, width, false);
				assertBackground(terminal, changed.findIndex((line) => line.includes("2. Reject")), 0, width, mode !== "none");
				if (mode === "none") assert.equal(updated.join("").includes("\x1b"), false);
			} finally {
				terminal.dispose();
			}
		}
	}
});

test("shell approvals prefer the model justification and fall back to the policy reason", () => {
	const runtimeReason = "This command uses shell syntax that requires manual review.";
	const modelReason = "May I download the test fixtures?";
	const cases: readonly (Pick<MycliShellPendingApproval, "reason" | "justification"> & {
		readonly expected?: string;
	})[] = [
		{ reason: runtimeReason, expected: runtimeReason },
		{ reason: runtimeReason, justification: modelReason, expected: modelReason },
		{ justification: modelReason, expected: modelReason },
		{},
	];
	for (const toolName of ["Shell", "Bash", "exec_command"]) {
		for (const { expected, ...reasons } of cases) {
			const selector = new ApprovalSelectorComponent({
				approval: { decisionId: "reason-selection", toolName, preview: "Generic command summary",
					commandPreview: "printf '%s\\n' \"$reply\"", ...reasons,
					options: [{ choice: "approve_once", label: "Allow once" }, { choice: "reject", label: "Reject" }] },
				onSelect: () => undefined, onCancel: () => undefined,
			});
			for (const fullText of [false, true]) {
				if (fullText) selector.handleInput("\x01");
				const display = stripAnsi(selector.render(100).join("\n"));
				const reasonLines = display.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("Reason:"));
				assert.deepEqual(reasonLines, expected ? [`Reason: ${expected}`] : [], `${toolName}, fullText=${fullText}`);
				if (reasons.justification) assert.ok(!display.includes(runtimeReason));
				assert.doesNotMatch(display, /Approval:|Generic command summary/u);
				assert.ok(display.includes("$ printf '%s\\n' \"$reply\""));
				assert.match(display, /1\. Allow once/u);
				assert.match(display, /2\. Reject/u);
			}
		}
	}
});

test("non-shell approvals retain their own reason when justification is also present", () => {
	const selector = new ApprovalSelectorComponent({
		approval: {
			decisionId: "permission-reason", toolName: "request_permissions", preview: "Read report sources",
			reason: "Read the requested report sources.", justification: "Shell-only fallback.",
			options: [{ choice: "approve_once", label: "Allow once" }, { choice: "reject", label: "Reject" }],
		},
		onSelect: () => undefined, onCancel: () => undefined,
	});
	const display = stripAnsi(selector.render(100).join("\n"));
	assert.match(display, /Reason: Read the requested report sources\./u);
	assert.doesNotMatch(display, /Shell-only fallback/u);
});

test("shell approval preview respects NO_COLOR and ASCII terminal glyphs", () => {
	const fixture = fileURLToPath(new URL("../../fixtures/render-shell-approval.ts", import.meta.url));
	const result = spawnSync(process.execPath, ["--import", "tsx", fixture, "40"], {
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined, TERM: "dumb" },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, stripAnsi(result.stdout));
	assert.match(result.stdout, /\$ npm run build/u);
	assert.match(result.stdout, /> 1\. Allow once/u);
	assert.match(result.stdout, /2\. Reject/u);
	assert.doesNotMatch(result.stdout, /[\u203a\u2500]/u);
	assert.ok(result.stdout.split("\n").every((line) => visibleWidth(line) <= 40));
});
