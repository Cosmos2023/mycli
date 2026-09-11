import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { builtinProviderInventory, renderBuiltinProviderInventory, reviewedAdapterLimitations, REVIEWED_PI_AI_VERSION } from "../support/builtin-provider-inventory.ts";

test("every actual builtin provider has a reviewed API, auth, adapter and hook disposition", async () => {
	const sdkPackage: { readonly version: string } = JSON.parse(await readFile(
		new URL("../package.json", import.meta.resolve("@earendil-works/pi-ai")), "utf8",
	)) as { readonly version: string };
	assert.equal(sdkPackage.version, REVIEWED_PI_AI_VERSION, "Review native adapter hooks when upgrading the SDK");
	const rows = await builtinProviderInventory();
	assert.deepEqual(rows.map((row) => row.provider).sort(), builtinProviders().map((provider) => provider.id).sort());
	for (const row of rows) {
		assert.ok(row.implementations.length > 0, row.provider);
		assert.ok(row.sdkAuth.length > 0, row.provider);
		assert.ok(row.activationReason, row.provider);
		if (row.status !== "unsupported") {
			assert.ok(row.hooks.some((hook) => hook.includes("fetch=supported, onResponse=supported")), row.provider);
		}
	}
	const report = await readFile(new URL("../../../../../docs/provider-catalog-evidence.md", import.meta.url), "utf8");
	assert.ok(report.includes(`@earendil-works/pi-ai@${REVIEWED_PI_AI_VERSION}`));
	assert.ok(report.includes(renderBuiltinProviderInventory(rows)), "Regenerate and review the catalog report after SDK or disposition changes");
	for (const limitation of reviewedAdapterLimitations()) assert.ok(report.includes(limitation), limitation);
});
