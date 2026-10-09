import assert from "node:assert/strict";
import test from "node:test";
import { HelpOverlayComponent } from "../src/components/selectors/help-overlay.ts";
import type { MycliShellCommandSpec } from "../src/model.ts";
import {
	CombinedAutocompleteProvider,
	ScopedSlashAutocompleteProvider,
	type AutocompleteSuggestions,
	type SlashCommand,
} from "../src/tui-core/autocomplete.ts";

const commands: readonly MycliShellCommandSpec[] = Object.freeze([
	{ id: "status", name: "/status", description: "runtime status", argumentPolicy: "none",
		availableDuringTurn: true, scope: "top", category: "diagnostics" },
	{ id: "config", name: "/config", description: "configuration", argumentPolicy: "none",
		availableDuringTurn: true, scope: "top", category: "interface" },
	{ id: "model", name: "/model", description: "choose a model", argumentPolicy: "none",
		availableDuringTurn: true, scope: "config", category: "model" },
	{ id: "settings", name: "/settings", description: "visual settings", argumentPolicy: "none",
		availableDuringTurn: true, scope: "config", category: "interface" },
]);

test("help lists configuration in its own group instead of the navigation categories", () => {
	const overlay = new HelpOverlayComponent({ commands, onClose: () => undefined });
	const output = overlay.render(100).join("\n");

	assert.match(output, /Configuration \(\/config\)/u);
	const configIndex = output.indexOf("Configuration (/config)");
	assert.ok(configIndex >= 0);
	// Grouped commands appear after the navigation groups, so browsing stays small.
	const grouped = output.slice(configIndex);
	assert.match(grouped, /\/model/u);
	assert.match(grouped, /\/settings/u);
	assert.doesNotMatch(output.slice(0, configIndex), /\/model/u);
	assert.match(output.slice(0, configIndex), /\/status/u);
});

test("slash autocomplete browses grouped commands but still matches every prefix", async () => {
	const seen: (readonly SlashCommand[])[] = [];
	const inner = {
		setCommands(next: readonly SlashCommand[]): void { seen.push(next); },
		getSuggestions: async (): Promise<AutocompleteSuggestions | null> => null,
	} as unknown as CombinedAutocompleteProvider;
	const browsing: SlashCommand[] = [{ name: "config" }, { name: "status" }];
	const complete: SlashCommand[] = [...browsing, { name: "model" }];
	const provider = new ScopedSlashAutocompleteProvider(inner, browsing, complete);
	const options = { signal: new AbortController().signal };

	await provider.getSuggestions(["/"], 0, 1, options);
	assert.deepEqual(seen.at(-1)?.map((command) => command.name), ["config", "status"]);
	await provider.getSuggestions(["/mo"], 0, 3, options);
	assert.deepEqual(seen.at(-1)?.map((command) => command.name), ["config", "status", "model"]);
	// The wrapper keeps Tab-driven file completion working.
	assert.equal(typeof provider.shouldTriggerFileCompletion, "function");
});
