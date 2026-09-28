import assert from "node:assert/strict";
import test from "node:test";
import { freezeLoopbackPorts, intersectLoopbackAccess, loopbackAccessIsSubset, type LoopbackAccess } from "../../src/index.ts";

test("loopback TCP lists reject malformed bounds and freeze a normalized copy", () => {
	const source = [65535, 1, 5432, 5432];
	const ports = freezeLoopbackPorts(source);
	source.push(8080);
	assert.deepEqual(ports, [1, 5432, 65535]);
	assert.ok(Object.isFrozen(ports));
	assert.deepEqual(freezeLoopbackPorts([]), []);
	for (const value of [null, {}, "5432", ["5432"], [NaN], [Infinity], [0], [-1], [65536], [1.5], Array(1), Array(65).fill(443)]) {
		assert.throws(() => freezeLoopbackPorts(value), /loopback_ports/u);
	}
});

test("all loopback intersections are subsets of both ceilings, including boolean overrides", () => {
	const cases: readonly LoopbackAccess[] = [
		{}, { allowLocalBinding: false }, { allowLocalBinding: true },
		{ loopbackPorts: [] }, { loopbackPorts: [5432] }, { loopbackPorts: [8080] },
		{ loopbackPorts: [5432, 8080], allowLocalBinding: true },
	];
	for (const current of cases) for (const ceiling of cases) {
		const result = intersectLoopbackAccess(current, ceiling);
		assert.ok(loopbackAccessIsSubset(result, current));
		assert.ok(loopbackAccessIsSubset(result, ceiling));
	}
	assert.equal(loopbackAccessIsSubset({ allowLocalBinding: true }, { allowLocalBinding: true, loopbackPorts: [] }), false);
	assert.equal(loopbackAccessIsSubset({ loopbackPorts: [5432] }, { allowLocalBinding: true }), true);
	assert.deepEqual(intersectLoopbackAccess({ loopbackPorts: [5432] }, { loopbackPorts: [8080] }), { loopbackPorts: [] });
});
