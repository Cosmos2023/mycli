import assert from "node:assert/strict";
import test from "node:test";
import type { ConfigMigrationResponse, ConfigShowResponse } from "../src/management/config.ts";
import { DoctorRepairService, configMigrationRepairHandler } from "../src/management/doctor/repair.ts";
import { reportFromChecks } from "../src/management/doctor/runner.ts";
import { DoctorManagementService } from "../src/management/doctor/service.ts";
import type { DoctorSupportBundle } from "../src/management/doctor/types.ts";
import { renderManagementResponse } from "../src/management/render.ts";

const VERSION = `migration-v1-${"c".repeat(64)}`;

test("doctor management reruns diagnostics only after a confirmed repair changes state", async () => {
	let reportRuns = 0;
	let applyCalls = 0;
	let applied = false;
	const config = {
		show: async () => configShow(),
		previewMigration: async () => migrationResponse("preview", !applied),
		applyMigration: async () => {
			applyCalls += 1;
			applied = true;
			return migrationResponse("apply", true);
		},
	};
	const service = new DoctorManagementService({
		homeDir: "/unused",
		workspaceTrust: "trusted",
		config,
		sandbox: { execute: async () => sandboxStatus() },
		runReport: () => {
			reportRuns += 1;
			return reportFromChecks([{ name: "config", status: "warning", message: "migration" }]);
		},
		repairService: new DoctorRepairService([configMigrationRepairHandler(config)]),
	});
	const signal = new AbortController().signal;
	const preview = await service.execute({
		kind: "doctor",
		operation: "fix",
		json: true,
		verbose: false,
	}, signal);

	assert.equal(preview.repair?.status, "preview");
	assert.equal(applyCalls, 0);
	assert.equal(reportRuns, 1);
	const previewText = renderManagementResponse({
		kind: "doctor",
		operation: "fix",
		json: false,
		verbose: true,
	}, preview);
	const previewJson = JSON.parse(renderManagementResponse({
		kind: "doctor",
		operation: "fix",
		json: true,
		verbose: true,
	}, preview)) as typeof preview;
	assert.match(previewText, new RegExp(preview.repair!.plan.planId, "u"));
	assert.match(previewText, /action=migrate_user_config changes=1/u);
	assert.equal(previewJson.repair?.plan.planId, preview.repair?.plan.planId);
	assert.deepEqual(previewJson.repair?.plan.actions, preview.repair?.plan.actions);

	const appliedResponse = await service.execute({
		kind: "doctor",
		operation: "fix",
		expectedPlanId: preview.repair!.plan.planId,
		json: true,
		verbose: false,
	}, signal);
	assert.equal(appliedResponse.repair?.status, "completed");
	assert.equal(applyCalls, 1);
	assert.equal(reportRuns, 3);
});

test("doctor management contains an incomplete repair preview", async () => {
	let applyCalls = 0;
	const service = new DoctorManagementService({
		homeDir: "/unused",
		workspaceTrust: "trusted",
		config: {
			show: async () => configShow(),
			previewMigration: async () => ({
				...migrationResponse("preview", true),
				truncated: true,
			}),
			applyMigration: async () => {
				applyCalls += 1;
				return migrationResponse("apply", true);
			},
		},
		sandbox: { execute: async () => sandboxStatus() },
		runReport: () => reportFromChecks([{ name: "runtime", status: "ok", message: "ready" }]),
	});
	const response = await service.execute({
		kind: "doctor",
		operation: "fix",
		json: true,
		verbose: false,
	}, new AbortController().signal);

	assert.equal(response.ok, false);
	assert.equal(response.repair, undefined);
	assert.deepEqual(response.issues, ["repair_preview_failed"]);
	assert.equal(applyCalls, 0);
});

test("support export survives config and sandbox metadata failures with bounded fallback", async () => {
	let written: DoctorSupportBundle | undefined;
	const service = new DoctorManagementService({
		homeDir: "/unused",
		workspaceTrust: "unknown",
		config: {
			show: async () => { throw new Error("sk-private-config-secret /Users/alice/config"); },
			previewMigration: async () => migrationResponse("preview", false),
			applyMigration: async () => migrationResponse("apply", false),
		},
		sandbox: {
			execute: async () => { throw new Error("Authorization: Bearer private-sandbox-secret"); },
		},
		runReport: () => reportFromChecks([{
			name: "config",
			status: "failed",
			message: "configuration invalid",
			category: "config",
		}]),
		writeBundle: async (_homeDir, bundle) => {
			written = bundle;
			return {
				schemaVersion: 1,
				location: ".mycli/support/diagnostic-support.json",
				bytes: 10,
				sha256: "d".repeat(64),
			};
		},
	});
	const response = await service.execute({
		kind: "doctor",
		operation: "support",
		json: true,
		verbose: false,
	}, new AbortController().signal);

	assert.equal(response.bundle?.location, ".mycli/support/diagnostic-support.json");
	assert.equal(response.exitCode, 1);
	assert.deepEqual(written?.configuration, { workspaceTrust: "unknown", layers: [] });
	assert.equal(written?.readiness.sandbox.code, "handshake_failed");
	assert.doesNotMatch(JSON.stringify({ response, written }), /private-|Bearer|alice/u);
	const supportText = renderManagementResponse({
		kind: "doctor",
		operation: "support",
		json: false,
		verbose: false,
	}, response);
	const supportJson = JSON.parse(renderManagementResponse({
		kind: "doctor",
		operation: "support",
		json: true,
		verbose: false,
	}, response)) as typeof response;
	assert.match(supportText, /Support bundle: ~\/\.mycli\/support\/diagnostic-support\.json/u);
	assert.match(supportText, new RegExp(response.bundle!.sha256, "u"));
	assert.deepEqual(supportJson.bundle, response.bundle);
});

test("support write failures return one stable issue", async () => {
	const service = new DoctorManagementService({
		homeDir: "/unused",
		workspaceTrust: "trusted",
		config: {
			show: async () => configShow(),
			previewMigration: async () => migrationResponse("preview", false),
			applyMigration: async () => migrationResponse("apply", false),
		},
		sandbox: { execute: async () => sandboxStatus() },
		runReport: () => reportFromChecks([{ name: "runtime", status: "ok", message: "ready" }]),
		writeBundle: async () => { throw new Error("sk-private-write-secret"); },
	});
	const response = await service.execute({
		kind: "doctor",
		operation: "support",
		json: true,
		verbose: false,
	}, new AbortController().signal);

	assert.equal(response.ok, false);
	assert.equal(response.exitCode, 1);
	assert.deepEqual(response.issues, ["support_bundle_write_failed"]);
	assert.doesNotMatch(JSON.stringify(response), /private-write-secret/u);
});

function configShow(): ConfigShowResponse {
	return {
		version: 1,
		ok: true,
		action: "show",
		message: "effective configuration",
		workspaceTrust: "trusted",
		credentials: { apiKey: "missing" },
		layers: [{ id: "user", scope: "user", enabled: true }],
		settings: [],
		diagnostics: [],
	};
}

function migrationResponse(
	operation: "apply" | "preview",
	needed: boolean,
): ConfigMigrationResponse {
	return {
		version: 1,
		ok: true,
		action: "migrate",
		operation,
		message: "migration",
		needed,
		...(operation === "apply" ? { applied: needed } : {}),
		expectedVersion: VERSION,
		currentVersion: "content-current",
		legacyVersion: "content-legacy",
		resultingVersion: "content-result",
		changes: needed ? [{
			kind: "normalize",
			key: "model.name",
			source: "user",
			effectiveSource: "user",
			overridden: [],
		}] : [],
		truncated: false,
		diagnostics: [],
	};
}

function sandboxStatus() {
	return {
		ok: true,
		action: "status" as const,
		message: "mycli sandbox status" as const,
		readiness: {
			state: "ready" as const,
			code: "ready" as const,
			platform: process.platform,
			isolation: "none" as const,
		},
		exitCode: 0 as const,
	};
}
