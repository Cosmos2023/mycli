import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	builtinCommandRoutingNames,
	commandDiscoveryManifest,
	commandManifest,
	resolveSlashCommand,
	SlashCommandError,
	slashCommandParityMatrix,
} from "../src/node-runtime/node-slash-command-registry.ts";

test("slash resolution accepts whitespace in arguments and canonical multiword commands", () => {
	for (const text of ["/mode\tplan", "/mode\nplan", "/mode  plan"]) {
		assert.equal(resolveSlashCommand({ text, surface: "tui", turnRunning: false }).args, "plan");
	}
	for (const text of ["/resume\ttarget", "/resume\ntarget"]) {
		const command = resolveSlashCommand({ text, surface: "tui", turnRunning: false });
		assert.equal(command.commandId, "resume");
		assert.equal(command.owner, "backend");
		assert.equal(command.args, "target");
	}
	for (const text of ["/session\tsearch\tcache hits", "/session  search\ncache hits"]) {
		const command = resolveSlashCommand({ text, surface: "tui", turnRunning: false });
		assert.equal(command.commandId, "session_search");
		assert.equal(command.args, "cache hits");
	}
});

test("retired command names are reserved for rejection and never appear in discovery", () => {
	const matrix = slashCommandParityMatrix();
	assert.ok(Array.isArray(matrix.retired_commands));
	const routingNames = builtinCommandRoutingNames();
	for (const surface of ["cli", "tui"] as const) {
		const commands = commandDiscoveryManifest(surface);
		assert.ok(commands.every((command) => command.aliases.length === 0));
		for (const retired of matrix.retired_commands as { name: string; replacement: string }[]) {
			assert.equal(routingNames.has(retired.name), true, retired.name);
			assert.equal(commands.some((command) => command.name === retired.name), false, retired.name);
			for (const separator of [" ", "\t", "\n"]) {
				for (const turnRunning of [false, true]) {
					assert.throws(() => resolveSlashCommand({
						text: `${retired.name.replaceAll(" ", separator)}${separator}private-argument`, surface, turnRunning,
					}), (error: unknown) => {
						assert.ok(error instanceof SlashCommandError);
						assert.equal(error.code, "invalid_arguments");
						assert.equal(error.message, `${retired.name} has been removed. Use ${retired.replacement} instead.`);
						return true;
					});
				}
			}
		}
	}
});

test("supported search-only commands retain their own routes", () => {
	const common = new Set(commandManifest("tui").map((command) => command.name));
	for (const command of commandDiscoveryManifest("tui")) {
		assert.equal(common.has(command.name), !command.search_only);
		assert.equal(resolveSlashCommand({ text: command.name, surface: "tui", turnRunning: false }).commandId, command.id);
	}
	for (const text of ["/tmp", "/tasks/file", "/session/search"]) {
		assert.throws(() => resolveSlashCommand({ text, surface: "tui", turnRunning: false }),
			(error: unknown) => error instanceof SlashCommandError && error.code === "unknown_command");
	}
	const kill = resolveSlashCommand({ text: "/agents\tkill\tchild-1", surface: "tui", turnRunning: false });
	assert.equal(kill.commandId, "agents");
	assert.equal(kill.args, "kill\tchild-1");
});

test("integration domains have independent common entries and tools remains diagnostic", () => {
	const common = commandManifest("tui");
	for (const name of ["/mcp", "/plugins", "/skills", "/hooks"]) {
		assert.equal(common.find((command) => command.name === name)?.category, "integrations");
	}
	assert.equal(common.some((command) => command.name === "/tools"), false);
	assert.equal(commandDiscoveryManifest("tui").find((command) => command.name === "/tools")?.search_only, true);
});

test("conversation export is discoverable without arguments and cannot run during a model turn", () => {
	for (const surface of ["tui", "cli"] as const) {
		const command = commandManifest(surface).find((item) => item.name === "/export");
		assert.equal(command?.category, "session");
		assert.equal(command?.argument_hint ?? "", "");
		assert.equal(resolveSlashCommand({ text: "/export", surface, turnRunning: false }).owner, "backend");
		assert.throws(() => resolveSlashCommand({ text: "/export", surface, turnRunning: true }),
			(error: unknown) => error instanceof SlashCommandError && error.code === "unavailable_during_turn");
	}
});

test("Node slash registry matches the current command and retirement matrix", () => {
	const fixture = JSON.parse(readFileSync(new URL(
		"./fixtures/node-slash-command-matrix.json",
		import.meta.url,
	), "utf8")) as {
		readonly schema_version: number;
		readonly command_count: number;
		readonly retired_command_count: number;
		readonly sha256: string;
	};
	const matrix = slashCommandParityMatrix();
	assert.ok(Array.isArray(matrix.commands));
	assert.ok(Array.isArray(matrix.retired_commands));
	const maintenance = matrix.commands.find((value) => (
		typeof value === "object" && value !== null && "id" in value
		&& value.id === "session_maintenance"
	)) as Readonly<Record<string, unknown>> | undefined;
	assert.equal(
		maintenance?.argument_hint,
		"[--apply-empty|--apply-payloads|--apply-orphans|--apply-vacuum|--apply-transcript-normalization|--apply-content-blobs|--apply-content-blob-gc]",
	);
	assert.equal(maintenance?.available_during_turn, false);
	assert.equal(fixture.schema_version, 3);
	assert.equal(matrix.commands.length, fixture.command_count);
	assert.equal(matrix.retired_commands.length, fixture.retired_command_count);
	assert.equal(
		createHash("sha256").update(JSON.stringify(matrix)).digest("hex"),
		fixture.sha256,
	);
});

test("documented commands and retirements stay aligned with the canonical slash registry", () => {
	const docs = readFileSync(new URL("../../../../docs/commands.md", import.meta.url), "utf8");
	const matrix = slashCommandParityMatrix();
	assert.ok(Array.isArray(matrix.commands));
	assert.ok(Array.isArray(matrix.retired_commands));
	for (const value of matrix.commands) {
		assert.equal(typeof value, "object");
		assert.ok(value !== null);
		const command = value as { readonly name: string; readonly aliases: readonly string[] };
		assert.ok(docs.includes(`| \`${command.name}\` |`), command.name);
		for (const alias of command.aliases) assert.ok(docs.includes(`\`${alias}\``), alias);
	}
	for (const value of matrix.retired_commands) {
		assert.equal(typeof value, "object");
		assert.ok(value !== null);
		const retired = value as { readonly name: string; readonly replacement: string };
		assert.ok(docs.includes(`\`${retired.name}\``), retired.name);
		assert.ok(docs.includes(`\`${retired.replacement}\``), retired.replacement);
	}
});
