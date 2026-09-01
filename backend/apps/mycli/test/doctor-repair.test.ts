import assert from "node:assert/strict";
import test from "node:test";
import type { ConfigMigrationResponse } from "../src/management/config.ts";
import {
	aggregateDoctorRepairStatus,
	configMigrationRepairHandler,
	DoctorRepairService,
} from "../src/management/doctor/repair.ts";
import type { DoctorRepairResult } from "../src/management/doctor/types.ts";

const VERSION = `migration-v1-${"a".repeat(64)}`;

test("doctor repairs preview without mutation and apply only the confirmed plan", async () => {
	let applied = false;
	let applyCalls = 0;
	const config = {
		previewMigration: async (): Promise<ConfigMigrationResponse> => applied
			? migrationPreview(false)
			: migrationPreview(true),
		applyMigration: async (expectedVersion: string): Promise<ConfigMigrationResponse> => {
			applyCalls += 1;
			assert.equal(expectedVersion, VERSION);
			applied = true;
			return migrationApply(true);
		},
	};
	const repairs = new DoctorRepairService([configMigrationRepairHandler(config)]);
	const preview = await repairs.execute(undefined, new AbortController().signal);

	assert.equal(preview.mode, "preview");
	assert.equal(preview.status, "preview");
	assert.equal(preview.plan.confirmationRequired, true);
	assert.match(preview.plan.planId, /^doctor-plan-v1-[a-f0-9]{64}$/u);
	assert.deepEqual(preview.plan.actions[0]?.changes, [{
		kind: "import",
		key: "model.name",
		source: "legacy_user",
		effectiveSource: "user",
		overridden: [],
	}]);
	assert.equal(applyCalls, 0);
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(
		repairs.execute(preview.plan.planId, cancelled.signal),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
	assert.equal(applyCalls, 0);

	const conflict = await repairs.execute(
		`doctor-plan-v1-${"b".repeat(64)}`,
		new AbortController().signal,
	);
	assert.equal(conflict.status, "version_conflict");
	assert.equal(applyCalls, 0);

	const execution = await repairs.execute(preview.plan.planId, new AbortController().signal);
	assert.equal(execution.status, "completed");
	assert.deepEqual(execution.results, [{
		id: "migrate_user_config",
		status: "applied",
		code: "config_migration_applied",
		changed: true,
		backupId: "20260901T000000000Z-backup",
	}]);
	assert.equal(applyCalls, 1);
	const noRepair = await repairs.execute(undefined, new AbortController().signal);
	assert.equal(noRepair.mode, "preview");
	assert.equal(noRepair.status, "not_needed");
	assert.equal(applyCalls, 1);

	const repeated = await repairs.execute(preview.plan.planId, new AbortController().signal);
	assert.equal(repeated.status, "version_conflict");
	assert.equal(applyCalls, 1);
});

test("doctor repair refuses an incomplete preview before confirmation", async () => {
	let applyCalls = 0;
	const repairs = new DoctorRepairService([configMigrationRepairHandler({
		previewMigration: async () => Object.freeze({
			...migrationPreview(true),
			truncated: true,
		}),
		applyMigration: async () => {
			applyCalls += 1;
			return migrationApply(true);
		},
	})]);

	await assert.rejects(
		repairs.execute(undefined, new AbortController().signal),
		/incomplete_doctor_repair_preview/u,
	);
	assert.equal(applyCalls, 0);
});

test("doctor repair failures stay bounded and partial status is explicit", async () => {
	const repairs = new DoctorRepairService([{
		id: "migrate_user_config",
		preview: () => configMigrationRepairHandler({
			previewMigration: async () => migrationPreview(true),
			applyMigration: async () => migrationApply(false),
		}).preview(new AbortController().signal),
		apply: () => { throw new Error("Authorization: Bearer private-repair-secret"); },
	}]);
	const preview = await repairs.execute(undefined, new AbortController().signal);
	const execution = await repairs.execute(preview.plan.planId, new AbortController().signal);

	assert.equal(execution.status, "failed");
	assert.deepEqual(execution.results, [{
		id: "migrate_user_config",
		status: "failed",
		code: "repair_failed",
		changed: false,
	}]);
	assert.doesNotMatch(JSON.stringify(execution), /private-repair-secret|Bearer/u);

	const results: readonly DoctorRepairResult[] = [
		{ id: "migrate_user_config", status: "applied", code: "applied", changed: true },
		{ id: "migrate_user_config", status: "failed", code: "failed", changed: false },
	];
	assert.equal(aggregateDoctorRepairStatus(results), "partial_failure");
});

function migrationPreview(needed: boolean): ConfigMigrationResponse {
	return Object.freeze({
		version: 1,
		ok: true,
		action: "migrate",
		operation: "preview",
		message: needed ? "configuration migration available" : "configuration migration not needed",
		needed,
		expectedVersion: VERSION,
		currentVersion: "content-v1-current",
		legacyVersion: "content-v1-legacy",
		resultingVersion: "content-v1-result",
		changes: needed ? Object.freeze([Object.freeze({
			kind: "import",
			key: "model.name",
			source: "legacy_user",
			effectiveSource: "user",
			overridden: Object.freeze([]),
		})]) : Object.freeze([]),
		truncated: false,
		diagnostics: Object.freeze([]),
	});
}

function migrationApply(applied: boolean): ConfigMigrationResponse {
	return Object.freeze({
		version: 1,
		ok: true,
		action: "migrate",
		operation: "apply",
		message: applied ? "configuration migration applied" : "configuration migration not needed",
		needed: applied,
		applied,
		expectedVersion: VERSION,
		currentVersion: "content-v1-current",
		legacyVersion: "content-v1-legacy",
		resultingVersion: "content-v1-result",
		...(applied ? { backupId: "20260901T000000000Z-backup" } : {}),
		changes: Object.freeze([]),
		truncated: false,
		diagnostics: Object.freeze([]),
	});
}
