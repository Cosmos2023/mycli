import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ToolDefinition } from "@mycli/core";
import {
	defineIntegrationRegistration,
	type IntegrationRegistration,
} from "@mycli/integrations";
import {
	builtinToolManifest,
	type ToolAdapter,
} from "@mycli/tools";
import {
	createIntegrationComposition,
	type IntegrationCompositionSource,
} from "../src/node-runtime/integration-composition.ts";

test("integration composition starts sources deterministically and closes them in reverse once", async () => {
	const started: string[] = [];
	const closed: string[] = [];
	const builtin = builtinToolManifest();
	const builtinSnapshot = JSON.stringify(builtin);
	const sources = [
		source("subagent", "Task", started, closed),
		source("plugin", "PluginStatus", started, closed),
		source("mcp", "McpSearch", started, closed),
		source("skill", "Skill", started, closed, false),
	] satisfies readonly IntegrationCompositionSource[];

	const composition = await createIntegrationComposition({
		builtinManifest: builtin,
		sources,
		closeTimeoutMs: 100,
	});

	assert.deepEqual(started, ["skill", "mcp", "plugin", "subagent"]);
	assert.deepEqual(
		composition.registrations.map((registration) => registration.definition.name),
		["Skill", "McpSearch", "PluginStatus", "Task"],
	);
	assert.deepEqual(
		composition.manifest.tools.slice(-4).map((tool) => tool.name),
		["Skill", "McpSearch", "PluginStatus", "Task"],
	);
	assert.equal(JSON.stringify(builtin), builtinSnapshot);
	assert.equal(Object.isFrozen(composition.registrations), true);

	await composition.close();
	await composition.close();
	assert.deepEqual(closed, ["subagent", "plugin", "mcp"]);
});

test("integration composition closes initialized sources after startup failure", async () => {
	const closed: string[] = [];
	const sources: readonly IntegrationCompositionSource[] = [
		{
			id: "mcp",
			start: async () => ({
				registrations: [registration("McpSearch", "mcp")],
				close: async () => { closed.push("mcp"); },
			}),
		},
		{
			id: "plugin",
			start: async () => { throw new Error("private plugin startup failure"); },
		},
	];

	await assert.rejects(
		() => createIntegrationComposition({
			builtinManifest: builtinToolManifest(),
			sources,
			closeTimeoutMs: 100,
		}),
		/integration_start_failed/u,
	);
	assert.deepEqual(closed, ["mcp"]);
});

test("integration composition rejects duplicate routes and preserves the package DAG", async () => {
	const closed: string[] = [];
	await assert.rejects(
		() => createIntegrationComposition({
			builtinManifest: builtinToolManifest(),
			sources: [
				{
					id: "mcp",
					start: async () => ({
						registrations: [registration("Read", "mcp")],
						close: async () => { closed.push("mcp"); },
					}),
				},
			],
			closeTimeoutMs: 100,
		}),
		/duplicate_tool_route/u,
	);
	assert.deepEqual(closed, ["mcp"]);

	const [runtimePackage, integrationsPackage] = await Promise.all([
		readPackage(new URL("../../../packages/runtime/package.json", import.meta.url)),
		readPackage(new URL("../../../packages/integrations/package.json", import.meta.url)),
	]);
	assert.equal(runtimePackage.dependencies?.["@mycli/integrations"], undefined);
	assert.equal(integrationsPackage.dependencies?.["@mycli/runtime"], undefined);
});

function source(
	id: IntegrationCompositionSource["id"],
	name: string,
	started: string[],
	closed: string[],
	closable = true,
): IntegrationCompositionSource {
	return {
		id,
		start: async () => {
			started.push(id);
			return {
				registrations: [registration(name, id)],
				...(closable ? { close: async () => { closed.push(id); } } : {}),
			};
		},
	};
}

function registration(
	name: string,
	source: IntegrationRegistration["source"],
): IntegrationRegistration {
	const definition: ToolDefinition = Object.freeze({
		id: `${source}:${name}`,
		name,
		description: `${name} fixture`,
		inputSchema: Object.freeze({
			type: "object",
			properties: Object.freeze({}),
			required: Object.freeze([]),
			additionalProperties: false,
		}),
	});
	const adapter: ToolAdapter = {
		definition,
		execute: async () => ({
			success: true,
			modelOutput: "ok",
			summary: "ok",
			metadata: Object.freeze({}),
		}),
	};
	return defineIntegrationRegistration({
		id: definition.id,
		source,
		definition,
		adapter,
		originMetadata: { fixture: name },
	});
}

async function readPackage(path: string | URL): Promise<{
	readonly dependencies?: Readonly<Record<string, string>>;
}> {
	return JSON.parse(await readFile(path, "utf8")) as {
		readonly dependencies?: Readonly<Record<string, string>>;
	};
}
