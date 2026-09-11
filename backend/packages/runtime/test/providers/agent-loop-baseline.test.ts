import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface BaselineScenario {
	readonly name: string;
	readonly source: "root" | "subagent";
	readonly providerManifests: readonly unknown[];
	readonly transcript: readonly unknown[];
	readonly toolLifecycles: readonly unknown[];
	readonly approval: unknown;
	readonly clarification: unknown;
	readonly steering: readonly unknown[];
	readonly mailboxDelivery: readonly unknown[];
	readonly usage: Readonly<Record<string, number>>;
	readonly gatewayEvents: readonly string[];
	readonly providerLifecycle: readonly string[];
}

test("agent-loop baseline covers root and child durable behavior", async () => {
	const fixture = JSON.parse(await readFile(
		new URL("../fixtures/agent-loop-baseline.json", import.meta.url),
		"utf8",
	)) as { readonly schemaVersion: number; readonly scenarios: readonly BaselineScenario[] };
	assert.equal(fixture.schemaVersion, 1);
	assert.deepEqual(new Set(fixture.scenarios.map((scenario) => scenario.source)), new Set([
		"root",
		"subagent",
	]));
	for (const scenario of fixture.scenarios) {
		assert.ok(scenario.providerManifests.length > 0, scenario.name);
		assert.ok(scenario.transcript.length > 0, scenario.name);
		assert.ok(scenario.toolLifecycles.length > 0, scenario.name);
		assert.ok((scenario.usage.total_tokens ?? 0) > 0, scenario.name);
		assert.deepEqual(
			scenario.providerLifecycle.slice(0, 3),
			["prepared", "dispatch_started", "acknowledged"],
			scenario.name,
		);
		assert.match(scenario.gatewayEvents.at(-1) ?? "", /completed|failed|interrupted/u);
	}
	assert.ok(fixture.scenarios.some((scenario) => scenario.approval !== null));
	assert.ok(fixture.scenarios.some((scenario) => scenario.clarification !== null));
	assert.ok(fixture.scenarios.some((scenario) => scenario.steering.length > 0));
	assert.ok(fixture.scenarios.some((scenario) => scenario.mailboxDelivery.length > 0));
});
