import assert from "node:assert/strict";
import test from "node:test";
import { slashCommandArguments } from "../../src/gateway/slash-command.ts";

test("slash command boundaries accept whitespace and preserve argument contents", () => {
	for (const separator of [" ", "  ", "\t", "\n", "\r\n"]) {
		assert.equal(slashCommandArguments(`/model${separator}test-model`, "/model"), "test-model");
		assert.equal(slashCommandArguments(`/session${separator}resume${separator}target`, "/session resume"), "target");
	}
	assert.equal(slashCommandArguments(' /plugin:example:run\t{"text":"a  b\\tc"} ', "/plugin:example:run"), '{"text":"a  b\\tc"}');
	assert.equal(slashCommandArguments(" /help\n", "/help"), "");
});

test("slash command matching keeps paths, longer names, and regex characters literal", () => {
	for (const input of ["/models", "/model/file", "/tmp", "hello /model"]) {
		assert.equal(slashCommandArguments(input, "/model"), null);
	}
	assert.equal(slashCommandArguments("/plugin:a.b:run", "/plugin:a.b:run"), "");
	assert.equal(slashCommandArguments("/plugin:axb:run", "/plugin:a.b:run"), null);
	assert.equal(slashCommandArguments("/anything", ""), null);
});
