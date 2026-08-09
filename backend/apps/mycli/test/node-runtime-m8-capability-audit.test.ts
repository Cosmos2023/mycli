import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gatewayContractCatalog } from "@mycli/contracts";
import { builtinToolManifest } from "@mycli/tools";
import { slashCommandParityMatrix } from "../src/node-runtime/node-slash-command-registry.ts";

interface AuditFixture {
	readonly schema_version: number;
	readonly gateway: {
		readonly rpc_count: number;
		readonly event_count: number;
		readonly required_rpc: readonly string[];
		readonly required_events: readonly string[];
	};
	readonly slash_commands: {
		readonly command_count: number;
		readonly prefixed_alias_count: number;
		readonly sha256: string;
	};
	readonly tools: {
		readonly retained: readonly string[];
		readonly explicitly_retired: readonly string[];
	};
	readonly capabilities: readonly {
		readonly id: string;
		readonly disposition: "fixed" | "explicitly_retired" | "test_only" | "unresolved";
		readonly evidence: string;
	}[];
	readonly corpora: readonly {
		readonly id: string;
		readonly path: string;
		readonly sha256: string;
	}[];
}

const ROOT = new URL("../../../../", import.meta.url);

test("M8 retained capability audit has no unresolved rows and freezes the final parity corpus", () => {
	const fixture = JSON.parse(readFileSync(new URL(
		"./fixtures/node-runtime-m8-capability-audit.json",
		import.meta.url,
	), "utf8")) as AuditFixture;
	assert.equal(fixture.schema_version, 1);
	assert.equal(fixture.capabilities.some((row) => row.disposition === "unresolved"), false);
	assert.deepEqual(new Set(fixture.capabilities.map((row) => row.id)), new Set([
		"bootstrap_status",
		"user_message_lifecycle",
		"slash_commands",
		"sessions_transcript",
		"approvals",
		"clarifications",
		"turn_queue",
		"providers_tools",
		"compaction_memory",
		"persistent_shell",
		"extensions_subagents",
		"management_diagnostics",
		"shutdown_lifecycle",
		"ls_glob_grep",
		"implicit_subagent_budgets",
		"python_plugin_source_compatibility",
		"cross_backend_harnesses",
	]));

	assert.equal(gatewayContractCatalog.rpcMethods.length, fixture.gateway.rpc_count);
	assert.equal(gatewayContractCatalog.eventStreams.length, fixture.gateway.event_count);
	for (const method of fixture.gateway.required_rpc) {
		assert.ok(gatewayContractCatalog.rpcMethods.includes(method), method);
	}
	for (const event of fixture.gateway.required_events) {
		assert.ok(gatewayContractCatalog.eventStreams.includes(event), event);
	}

	const matrix = slashCommandParityMatrix();
	assert.ok(Array.isArray(matrix.commands));
	assert.ok(Array.isArray(matrix.prefixed_aliases));
	assert.equal(matrix.commands.length, fixture.slash_commands.command_count);
	assert.equal(matrix.prefixed_aliases.length, fixture.slash_commands.prefixed_alias_count);
	assert.equal(
		createHash("sha256").update(JSON.stringify(matrix)).digest("hex"),
		fixture.slash_commands.sha256,
	);
	const toolNames = builtinToolManifest().tools.map((tool) => tool.name);
	for (const retained of fixture.tools.retained) assert.ok(toolNames.includes(retained), retained);
	for (const retired of fixture.tools.explicitly_retired) assert.equal(toolNames.includes(retired), false, retired);

	for (const corpus of fixture.corpora) {
		const bytes = readFileSync(new URL(corpus.path, ROOT));
		assert.equal(createHash("sha256").update(bytes).digest("hex"), corpus.sha256, corpus.id);
	}
});
