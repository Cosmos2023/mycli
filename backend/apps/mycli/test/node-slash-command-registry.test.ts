import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { slashCommandParityMatrix } from "../src/node-runtime/node-slash-command-registry.ts";

test("Node slash registry matches the frozen final cross-backend command matrix", () => {
	const fixture = JSON.parse(readFileSync(new URL(
		"./fixtures/node-slash-command-matrix.json",
		import.meta.url,
	), "utf8")) as {
		readonly schema_version: number;
		readonly command_count: number;
		readonly prefixed_alias_count: number;
		readonly sha256: string;
	};
	const matrix = slashCommandParityMatrix();
	assert.ok(Array.isArray(matrix.commands));
	assert.ok(Array.isArray(matrix.prefixed_aliases));
	assert.equal(fixture.schema_version, 1);
	assert.equal(matrix.commands.length, fixture.command_count);
	assert.equal(matrix.prefixed_aliases.length, fixture.prefixed_alias_count);
	assert.equal(
		createHash("sha256").update(JSON.stringify(matrix)).digest("hex"),
		fixture.sha256,
	);
});
