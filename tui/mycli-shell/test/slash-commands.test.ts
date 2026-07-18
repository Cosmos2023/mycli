import assert from "node:assert/strict";
import test from "node:test";

import {
	clientActionFromResult,
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
			},
			{
				id: "usage",
				name: "/usage",
				description: "Show usage",
				argument_hint: null,
				argument_policy: "none",
				available_during_turn: true,
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
		},
		{
			id: "usage",
			name: "/usage",
			description: "Show usage",
			argumentPolicy: "none",
			availableDuringTurn: true,
		},
	]);
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
