import assert from "node:assert/strict";
import test from "node:test";
import { parsePackageVersion } from "../src/package-version.ts";

test("package version parser accepts one non-empty string version", () => {
	assert.equal(parsePackageVersion({ version: "0.1.0" }), "0.1.0");
});

test("package version parser rejects missing or malformed manifests", () => {
	for (const value of [undefined, null, {}, { version: "" }, { version: 1 }]) {
		assert.throws(() => parsePackageVersion(value), /package_version_invalid/u);
	}
});
