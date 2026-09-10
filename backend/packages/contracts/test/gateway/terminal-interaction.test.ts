import assert from "node:assert/strict";
import test from "node:test";
import { parseGatewayToolRecord, projectGatewayToolRecord, projectTerminalInteraction, terminalInteractionFromArguments } from "../../src/index.ts";

test("terminal interaction previews distinguish input from polling and preserve control input visibly", () => {
	assert.deepEqual(terminalInteractionFromArguments("WriteStdin", '{"session_id":"shell-1"}'), { shell_id: "shell-1", kind: "poll" });
	assert.equal(terminalInteractionFromArguments("Shell", { session_id: "shell-1" }), undefined);
	assert.equal(terminalInteractionFromArguments("WriteStdin", "{"), undefined);
	assert.equal(terminalInteractionFromArguments("WriteStdin", { session_id: "shell-1", chars: 1 }), undefined);
	for (const [chars, preview] of [["y\n", '"y\\n"'], ["\u0003", '"^C"'], ["\u0004", '"^D"'], [" ", '" "']]) {
		assert.deepEqual(terminalInteractionFromArguments("write_stdin", { session_id: "shell-1", chars }), {
			shell_id: "shell-1", kind: "input", input_preview: preview,
		});
	}
});

test("terminal interaction records bound and sanitize previews across projection and validation", () => {
	const interaction = terminalInteractionFromArguments("WriteStdin", {
		session_id: "shell-1", chars: "token=private-value\n\u001b[2J" + "x".repeat(20_000),
	});
	assert.ok(interaction);
	assert.doesNotMatch(JSON.stringify(interaction), /private-value/u);
	assert.ok((interaction.input_preview?.length ?? 0) <= 1_000);
	assert.ok(!interaction.input_preview?.includes("\u001b"));
	const record = projectGatewayToolRecord({ text: "WriteStdin", metadata: { tool_name: "WriteStdin",
		terminal_interaction: { ...interaction, command_preview: "node script.cjs", process_running: true,
			interaction_succeeded: true, private_field: "hidden" }, success: true } });
	assert.deepEqual(parseGatewayToolRecord(record), record);
	assert.equal(record.terminal_interaction?.command_preview, "node script.cjs");
	assert.doesNotMatch(JSON.stringify(record), /private_field|hidden/u);
	assert.equal(projectTerminalInteraction({ shell_id: "bad\nidentity", kind: "poll" }), undefined);
	assert.equal(projectTerminalInteraction({ shell_id: "shell-1", kind: "other" }), undefined);
});
