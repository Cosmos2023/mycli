import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ContractValidationError, parseGatewayEvent } from "../src/index.ts";

type Fixture = { name: string; valid: boolean; value: unknown };
const fixtures = JSON.parse(
	readFileSync(new URL("../fixtures/gateway-events.json", import.meta.url), "utf8"),
) as Fixture[];

for (const fixture of fixtures) {
	test(`gateway fixture: ${fixture.name}`, () => {
		if (fixture.valid) {
			assert.doesNotThrow(() => parseGatewayEvent(fixture.value));
		} else {
			assert.throws(() => parseGatewayEvent(fixture.value), ContractValidationError);
		}
	});
}

test("Python receives the canonical runtime-state schema byte-for-byte", () => {
	const canonical = readFileSync(
		new URL("../schemas/runtime-state.schema.json", import.meta.url),
		"utf8",
	);
	const pythonCopy = readFileSync(
		new URL("../../../src/mycli/schemas/generated/runtime-state.schema.json", import.meta.url),
		"utf8",
	);
	assert.equal(pythonCopy, canonical);
});
