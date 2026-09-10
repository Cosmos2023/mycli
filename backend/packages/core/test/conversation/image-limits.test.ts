import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCanonicalImages } from "../../src/index.ts";

test("canonical images are bounded, validated, and copied immutably", () => {
	const input = [{ mediaType: "image/png", data: "aW1hZ2U=" }];
	const normalized = normalizeCanonicalImages(input);
	assert.deepEqual(normalized, input);
	input[0]!.data = "changed";
	assert.equal(normalized[0]?.data, "aW1hZ2U=");
	assert.ok(Object.isFrozen(normalized));
	assert.ok(Object.isFrozen(normalized[0]));
	for (const invalid of [
		null, {}, [null], [{ mediaType: "text/plain", data: "aW1hZ2U=" }],
		[{ mediaType: "image/png", data: "" }], [{ mediaType: "image/png", data: "%%%=" }],
		[{ mediaType: "image/png", data: "aW1hZ2U" }],
		Array.from({ length: 17 }, () => normalized[0]),
		[{ mediaType: "image/png", data: "A".repeat(20_000_004) }],
		Array.from({ length: 3 }, () => ({ mediaType: "image/png", data: "A".repeat(8_000_000) })),
	]) assert.throws(() => normalizeCanonicalImages(invalid), /invalid canonical images/u);
});
