import assert from "node:assert/strict";
import test from "node:test";
import { CommandPaletteComponent } from "../src/components/selectors/command-palette.ts";
import type { MycliShellCommandSpec } from "../src/model.ts";
import type { TUI } from "../src/tui-core/index.ts";

const commands: readonly MycliShellCommandSpec[] = Object.freeze([
	{ id: "status", name: "/status", description: "runtime status", argumentPolicy: "none",
		availableDuringTurn: true, scope: "top" },
	{ id: "model", name: "/model", description: "choose a model", argumentPolicy: "none",
		availableDuringTurn: true, scope: "config" },
	{ id: "settings", name: "/settings", description: "visual settings", argumentPolicy: "none",
		availableDuringTurn: true, scope: "config" },
	{ id: "legacy", name: "/legacy", description: "no scope field", argumentPolicy: "none",
		availableDuringTurn: true },
]);

function palette(scope: "top" | "config"): CommandPaletteComponent {
	return new CommandPaletteComponent({
		tui: { requestRender: () => undefined } as unknown as TUI,
		commands,
		scope,
		turnRunning: false,
		onSelect: () => undefined,
		onCancel: () => undefined,
	});
}

function rendered(component: CommandPaletteComponent): string {
	return component.render(80).join("\n");
}

test("the default palette lists navigation commands and hides configuration", () => {
	const output = rendered(palette("top"));
	assert.match(output, /\/status/u);
	// A command without a scope field stays discoverable, matching the pre-grouping behavior.
	assert.match(output, /\/legacy/u);
	assert.doesNotMatch(output, /\/model/u);
	assert.doesNotMatch(output, /\/settings/u);
	assert.match(output, /Commands/u);
});

test("the configuration palette lists only scoped configuration commands", () => {
	const component = palette("config");
	const output = rendered(component);
	assert.match(output, /Configuration/u);
	assert.match(output, /\/model/u);
	assert.match(output, /\/settings/u);
	assert.doesNotMatch(output, /\/status/u);
	assert.doesNotMatch(output, /\/legacy/u);

	// Later catalog updates keep the same scope instead of leaking every command back in.
	component.setCommands([...commands]);
	const updated = rendered(component);
	assert.match(updated, /\/model/u);
	assert.doesNotMatch(updated, /\/status/u);
});
