import assert from "node:assert/strict";
import test from "node:test";

import {
	clientActionFromResult,
	isSlashCommandSubmission,
	slashCommandNamesFromResult,
	slashCommandsFromResult,
} from "../src/adapters/slash-commands.ts";


test("command manifest parser preserves gateway order and rejects malformed rows", () => {
	const commands = slashCommandsFromResult({
		commands: [
			{
				id: "model",
				name: "/model",
				description: "Choose model",
				argument_hint: "[model]",
				argument_policy: "optional",
				available_during_turn: true,
				aliases: ["/models"],
				category: "model",
				search_only: false,
				available: true,
			},
			{
				id: "usage",
				name: "/usage",
				description: "Show usage",
				argument_hint: null,
				argument_policy: "none",
				available_during_turn: true,
				category: "diagnostics",
				search_only: true,
				available: false,
				unavailable_reason: "Usage service is unavailable",
			},
			{ id: "broken", name: "broken", description: "Missing slash" },
		],
	});

	assert.deepEqual(commands, [
		{
			id: "model",
			name: "/model",
			description: "Choose model",
			argumentHint: "[model]",
			argumentPolicy: "optional",
			availableDuringTurn: true,
			aliases: ["/models"],
			category: "model",
			searchOnly: false,
			available: true,
		},
		{
			id: "usage",
			name: "/usage",
			description: "Show usage",
			argumentPolicy: "none",
			availableDuringTurn: true,
			aliases: [],
			category: "diagnostics",
			searchOnly: true,
			available: false,
			unavailableReason: "Usage service is unavailable",
		},
	]);
});

test("routing names distinguish registered commands from root absolute paths", () => {
	const names = slashCommandNamesFromResult({
		routing_names: ["/status", "/status usage", "/settings", "/status", "invalid"],
	});

	assert.deepEqual(names, ["/status", "/status usage", "/settings"]);
	assert.equal(isSlashCommandSubmission("/status usage", names), true);
	assert.equal(isSlashCommandSubmission("/settings", names), true);
	assert.equal(isSlashCommandSubmission("/tmp", names), false);
	assert.equal(isSlashCommandSubmission("/etc hosts", names), false);
	assert.equal(isSlashCommandSubmission("/does-not-exist", names), false);
});


test("client action parser requires a complete tui action response", () => {
	assert.deepEqual(
		clientActionFromResult({
			execution: "tui",
			client_action: "open_settings",
			args: "",
			command_id: "settings",
		}),
		{
			action: "open_settings",
			args: "",
			commandId: "settings",
		},
	);
	assert.equal(clientActionFromResult({ execution: "backend" }), null);
	assert.equal(
		clientActionFromResult({ execution: "tui", client_action: "open_settings" }),
		null,
	);
});
