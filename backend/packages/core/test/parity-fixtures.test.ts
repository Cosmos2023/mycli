import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { NoToolRequestProjectionInput } from "../src/index.ts";
import { projectNoToolRequest } from "../src/index.ts";

test("projects the shared Python/Node M2 request corpus without normalization", async () => {
	const fixture = JSON.parse(await readFile(
		new URL("../../../../tests/fixtures/node_runtime_m2/request_projection.json", import.meta.url),
		"utf8",
	)) as { schema_version: number; cases: Array<{
		name: string;
		input: NoToolRequestProjectionInput;
		expected: Record<string, unknown>;
	}> };
	assert.equal(fixture.schema_version, 1);
	for (const scenario of fixture.cases) {
		assert.deepEqual(projectNoToolRequest(scenario.input), scenario.expected, scenario.name);
	}
});
