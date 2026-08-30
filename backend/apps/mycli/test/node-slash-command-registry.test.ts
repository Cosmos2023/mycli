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
	const maintenance = matrix.commands.find((value) => (
		typeof value === "object" && value !== null && "id" in value
		&& value.id === "session_maintenance"
	)) as Readonly<Record<string, unknown>> | undefined;
	assert.equal(
		maintenance?.argument_hint,
		"[--apply-empty|--apply-payloads|--apply-orphans|--apply-vacuum|--apply-transcript-normalization|--apply-content-blobs|--apply-content-blob-gc]",
	);
	assert.equal(maintenance?.available_during_turn, false);
	assert.equal(fixture.schema_version, 2);
	assert.equal(matrix.commands.length, fixture.command_count);
	assert.equal(matrix.prefixed_aliases.length, fixture.prefixed_alias_count);
	assert.equal(
		createHash("sha256").update(JSON.stringify(matrix)).digest("hex"),
		fixture.sha256,
	);
});

test("documented commands and aliases stay aligned with the canonical slash registry", () => {
	const docs = readFileSync(new URL("../../../../docs/commands.md", import.meta.url), "utf8");
	const matrix = slashCommandParityMatrix();
	assert.ok(Array.isArray(matrix.commands));
	assert.ok(Array.isArray(matrix.prefixed_aliases));
	for (const value of matrix.commands) {
		assert.equal(typeof value, "object");
		assert.ok(value !== null);
		const command = value as { readonly name: string; readonly aliases: readonly string[] };
		assert.ok(docs.includes(`| \`${command.name}\` |`), command.name);
		for (const alias of command.aliases) assert.ok(docs.includes(`\`${alias}\``), alias);
	}
	for (const value of matrix.prefixed_aliases) {
		assert.equal(typeof value, "object");
		assert.ok(value !== null);
		const alias = (value as { readonly prefix: string }).prefix;
		assert.ok(docs.includes(`\`${alias}\``), alias);
	}
});
