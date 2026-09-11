import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CachedUpdateService } from "@mycli/config";
import { collectUpdateChecks } from "../src/management/doctor/check-update.ts";
import { renderManagementResponse } from "../src/management/render.ts";
import { UpdateManagementService } from "../src/management/update.ts";

test("update management checks, renders guidance, and dismisses only the advertised version", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const cache = new CachedUpdateService({
		homeDir,
		packageName: "@cosmos2023/mycli",
		currentVersion: "1.0.0",
		now: () => new Date("2026-08-30T00:00:00.000Z"),
		fetch: (async () => new Response(JSON.stringify({ version: "1.1.0" }), { status: 200 })) as typeof fetch,
		env: { npm_config_user_agent: "npm/11.0.0 node/v24" },
	});
	const service = new UpdateManagementService({ cache, checkOnStartup: () => true });
	const signal = new AbortController().signal;

	const checked = await service.check(signal);
	assert.equal(checked.ok, true);
	assert.equal(checked.refreshOutcome, "refreshed");
	assert.equal(checked.status.availability, "available");
	const rendered = renderManagementResponse(
		{ kind: "update", action: "status", json: false },
		await service.status(signal),
	);
	assert.match(rendered, /^mycli update status\n/u);
	assert.match(rendered, /status=available/u);
	assert.match(rendered, /install_command=npm install -g @cosmos2023\/mycli@latest/u);

	const invalid = await service.dismiss("1.1.1", signal);
	assert.equal(invalid.ok, false);
	assert.deepEqual(invalid.issues, ["update_version_unavailable"]);
	const dismissed = await service.dismiss("1.1.0", signal);
	assert.equal(dismissed.ok, true);
	assert.equal(dismissed.status.availability, "dismissed");
	await cache.close();
});

test("doctor update projection is provider-free, structured, and actionable", async () => {
	const status = {
		schemaVersion: 1,
		packageName: "@cosmos2023/mycli",
		currentVersion: "1.0.0",
		checkOnStartup: true,
		availability: "available",
		cacheState: "fresh",
		latestVersion: "1.1.0",
		lastCheckedAt: "2026-08-30T00:00:00.000Z",
		install: {
			method: "npm",
			command: "npm install -g @cosmos2023/mycli@latest",
			fallback: false,
		},
	} as const;
	const checks = await collectUpdateChecks(() => status);

	assert.equal(checks.length, 1);
	assert.equal(checks[0]?.status, "warning");
	assert.equal(checks[0]?.category, "update");
	assert.equal(checks[0]?.code, "update_attention_required");
	assert.equal(checks[0]?.recoveryActions?.[0]?.id, "check_for_updates");
	assert.match(checks[0]?.remediation ?? "", /npm install -g/u);
});

test("explicit management checks refresh fresh cache while preserving startup opt-out", async (t) => {
	const homeDir = await temporaryDirectory(t);
	let requests = 0;
	let latest = "1.1.0";
	let now = new Date("2026-08-30T00:00:00.000Z");
	const cache = new CachedUpdateService({
		homeDir,
		packageName: "@cosmos2023/mycli",
		currentVersion: "1.0.0",
		now: () => now,
		fetch: (async () => {
			requests += 1;
			return new Response(JSON.stringify({ version: latest }), { status: 200 });
		}) as typeof fetch,
	});
	assert.equal((await cache.refreshIfNeeded(true)).outcome, "refreshed");

	latest = "1.2.0";
	now = new Date("2026-08-30T00:01:00.000Z");
	const service = new UpdateManagementService({ cache, checkOnStartup: () => false });
	const checked = await service.check(new AbortController().signal);
	assert.equal(checked.refreshOutcome, "refreshed");
	assert.equal(checked.status.checkOnStartup, false);
	assert.equal(checked.status.availability, "disabled");
	assert.equal(checked.status.latestVersion, "1.2.0");
	assert.equal(requests, 2);
	await cache.close();
});

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-update-management-"));
	t.after(async () => rm(path, { recursive: true, force: true }));
	return path;
}
