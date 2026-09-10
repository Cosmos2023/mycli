import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { CommandResultOverlayComponent } from "../../src/components/selectors/command-result-overlay.ts";
import type { MycliShellCommandResult } from "../../src/model.ts";
import { visibleWidth } from "../../src/tui-core/utils.ts";

function skillList(): MycliShellCommandResult {
	return {
		id: "skills", folded: true, fallbackLines: [],
		display: {
			version: 1, kind: "list", command: "/skills", title: "Skills", severity: "info",
			fields: [], sections: [], suggestions: [], omittedRows: 0, omittedChars: 0,
			rows: Array.from({ length: 24 }, (_, index) => ({
				key: `skill-${index + 1}`, label: `skill-${String(index + 1).padStart(2, "0")}`,
				values: ["repo"], status: index === 23 ? "disabled" : "enabled",
				detail: `Description for skill ${index + 1}. ${"Complete skill instructions overview. ".repeat(10)}END-OF-DETAIL`,
			})),
		},
	};
}

function screen(component: CommandResultOverlayComponent, width = 80): string {
	return stripAnsi(component.render(width).join("\n"));
}

test("skill and tool lists can reach entries beyond the folded transcript preview", () => {
	const component = new CommandResultOverlayComponent(skillList(), () => {});
	assert.match(screen(component), /skill-01/);
	component.handleInput("\x1b[F");
	assert.match(screen(component), /skill-24/);
	assert.match(screen(component), /disabled/);
	component.handleInput("\x1b[H");
	assert.match(screen(component), /skill-01/);
	component.handleInput("\x1b[6~");
	assert.doesNotMatch(screen(component), /[>\u203a] skill-01/);
});

test("list search matches metadata and full details; escape returns before closing", () => {
	let closes = 0;
	const component = new CommandResultOverlayComponent(skillList(), () => { closes += 1; });
	component.handleInput("disabled");
	assert.match(screen(component), /skill-24/);
	assert.doesNotMatch(screen(component), /skill-01/);
	component.handleInput("\r");
	assert.match(screen(component, 44), /Description for skill 24/);
	component.handleInput("\x1b[F");
	assert.match(screen(component, 44), /END-OF-DETAIL/);
	component.handleInput("\x1b");
	assert.equal(closes, 0);
	assert.match(screen(component), /skill-24/);
	component.handleInput("\x1b");
	assert.equal(closes, 1);
});

test("command overlays obey terminal height and cell width while resizing and inspecting", () => {
	let height = 9;
	const result = skillList();
	result.display.rows[0]!.label = "\u4e2d\u6587\u6280\u80fd\u540d\u79f0".repeat(8);
	const component = new CommandResultOverlayComponent(result, () => {}, { maxHeight: () => height });
	for (const width of [12, 36, 80]) {
		for (height of [1, 3, 9, 24]) {
			const lines = component.render(width);
			assert.ok(lines.length <= height, `${lines.length} rows exceed height ${height}`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	}
	component.handleInput("\r");
	for (height of [3, 9, 20]) {
		const lines = component.render(36);
		assert.ok(lines.length <= height);
		assert.ok(lines.every((line) => visibleWidth(line) <= 36));
	}
});

test("empty search results remain usable and bounded list omissions stay visible", () => {
	const result = skillList();
	result.display.totalRows = 35;
	result.display.omittedRows = 11;
	const component = new CommandResultOverlayComponent(result, () => {});
	assert.match(screen(component), /24.*35/);
	component.handleInput("no-such-skill");
	assert.match(screen(component), /No matching items/);
	component.handleInput("\r");
	assert.match(screen(component), /No matching items/);
});
