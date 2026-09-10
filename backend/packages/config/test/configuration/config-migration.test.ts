import assert from "node:assert/strict";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parse } from "smol-toml";
import {
	applyConfigMigration,
	configContentVersion,
	isConfigError,
	previewConfigMigration,
	rollbackConfigMigration,
	type ConfigMigrationOptions,
} from "../../src/index.ts";

const FIXED_DATE = new Date("2026-08-31T01:02:03.456Z");
const FIXED_UUID = "00000000-0000-4000-8000-000000000001";
const FIXED_BACKUP_ID = "20260831T010203456Z-00000000-0000-4000-8000-000000000001";

interface TestRoot {
	readonly homeDir: string;
	readonly workspaceRoot: string;
}

test("migration preview is read-only and preserves an absent user file version", async (t) => {
	const root = await temporaryRoot(t);
	const empty = await previewConfigMigration(migrationOptions(root));

	assert.equal(empty.needed, false);
	assert.equal(empty.currentVersion, configContentVersion(undefined));
	assert.equal(empty.resultingVersion, empty.currentVersion);
	await assert.rejects(access(userConfigPath(root)));
	await assert.rejects(access(backupDirectory(root)));

	const before = '# keep\nmodel = "private-model-sentinel"\n';
	await writeUserConfig(root, before);
	const preview = await previewConfigMigration(migrationOptions(root));

	assert.equal(preview.needed, true);
	assert.deepEqual(preview.changes.map(({ key, kind, source }) => ({ key, kind, source })), [{
		key: "model.name",
		kind: "normalize",
		source: "user",
	}]);
	assert.equal(await readFile(userConfigPath(root), "utf8"), before);
	assert.equal(JSON.stringify(preview).includes("private-model-sentinel"), false);
	await assert.rejects(access(backupDirectory(root)));
});

test("migration apply normalizes user aliases and imports legacy values into one private backup", async (t) => {
	const root = await temporaryRoot(t);
	const before = '# preserve\r\nmodel = "private-model-sentinel"\r\n';
	const legacy = "memory_enabled = true\n";
	await Promise.all([
		writeUserConfig(root, before),
		writeLegacyConfig(root, legacy),
		writeAuth(root, "private-auth-sentinel\n"),
	]);
	const preview = await previewConfigMigration(migrationOptions(root));
	const applied = await applyConfigMigration({
		...migrationOptions(root),
		expectedVersion: preview.expectedVersion,
	});

	assert.equal(applied.applied, true);
	assert.equal(applied.backupId, FIXED_BACKUP_ID);
	assert.deepEqual(applied.changes.map(({ key, kind, source }) => ({ key, kind, source })), [
		{ key: "memory.enabled", kind: "import", source: "legacy_user" },
		{ key: "model.name", kind: "normalize", source: "user" },
	].sort((left, right) => left.key.localeCompare(right.key)));
	const current = await readFile(userConfigPath(root), "utf8");
	assert.deepEqual(parse(current), {
		memory: { enabled: true },
		model: { name: "private-model-sentinel" },
	});
	assert.match(current, /# preserve\r\n/u);
	assert.equal(await readFile(legacyConfigPath(root), "utf8"), legacy);
	assert.equal(await readFile(authPath(root), "utf8"), "private-auth-sentinel\n");
	assert.equal(JSON.stringify(applied).includes("private-model-sentinel"), false);

	const backupPath = join(backupDirectory(root), `${FIXED_BACKUP_ID}.json`);
	const backup = JSON.parse(await readFile(backupPath, "utf8")) as Record<string, unknown>;
	assert.equal(Buffer.from(String(backup.beforeContentBase64), "base64").toString("utf8"), before);
	assert.equal(backup.beforeVersion, configContentVersion(before));
	assert.equal(backup.afterVersion, configContentVersion(current));
	if (process.platform !== "win32") {
		assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
		assert.equal((await stat(backupDirectory(root))).mode & 0o777, 0o700);
	}
});

test("migration apply rejects a stale preview without replacing current bytes", async (t) => {
	const root = await temporaryRoot(t);
	await writeUserConfig(root, 'model = "first"\n');
	const preview = await previewConfigMigration(migrationOptions(root));
	const concurrent = 'model = "concurrent-private-sentinel"\n';
	await writeFile(userConfigPath(root), concurrent, "utf8");

	await assert.rejects(
		() => applyConfigMigration({
			...migrationOptions(root),
			expectedVersion: preview.expectedVersion,
		}),
		(error: unknown) => hasConfigCode(error, "version_conflict"),
	);
	assert.equal(await readFile(userConfigPath(root), "utf8"), concurrent);
	await assert.rejects(access(backupDirectory(root)));
});

test("migration apply preserves source bytes and redacts unexpected pre-rename failures", async (t) => {
	const root = await temporaryRoot(t);
	const before = '# exact bytes\r\nmodel = "private-model-sentinel"\r\n';
	await writeUserConfig(root, before);
	const preview = await previewConfigMigration(migrationOptions(root));

	await assert.rejects(
		() => applyConfigMigration({
			...migrationOptions(root),
			expectedVersion: preview.expectedVersion,
			failpoint: (name) => {
				if (name === "before_rename") throw new Error("private-failpoint-sentinel");
			},
		}),
		(error: unknown) => {
			assert.equal(hasConfigCode(error, "config_write_failed"), true);
			assert.doesNotMatch(JSON.stringify(error), /private-(?:model|failpoint)-sentinel/u);
			return true;
		},
	);
	assert.equal(await readFile(userConfigPath(root), "utf8"), before);
});

test("migration rollback restores exact bytes and never changes auth storage", async (t) => {
	const root = await temporaryRoot(t);
	const before = '# exact bytes\r\nmodel = "legacy-model"\r\n';
	const auth = '{"openai":"private-auth-sentinel"}\n';
	await Promise.all([writeUserConfig(root, before), writeAuth(root, auth)]);
	const preview = await previewConfigMigration(migrationOptions(root));
	const applied = await applyConfigMigration({
		...migrationOptions(root),
		expectedVersion: preview.expectedVersion,
	});
	assert.ok(applied.backupId);

	const rollback = await rollbackConfigMigration({
		...migrationOptions(root),
		backupId: applied.backupId,
	});

	assert.equal(rollback.restored, true);
	assert.equal(rollback.currentVersion, configContentVersion(before));
	assert.equal(await readFile(userConfigPath(root), "utf8"), before);
	assert.equal(await readFile(authPath(root), "utf8"), auth);
	assert.equal(JSON.stringify(rollback).includes("private-auth-sentinel"), false);
});

test("migration rollback restores the prior absence of the user config", async (t) => {
	const root = await temporaryRoot(t);
	await writeLegacyConfig(root, "memory_enabled = true\n");
	const preview = await previewConfigMigration(migrationOptions(root));
	const applied = await applyConfigMigration({
		...migrationOptions(root),
		expectedVersion: preview.expectedVersion,
	});
	assert.ok(applied.backupId);
	await access(userConfigPath(root));

	const rollback = await rollbackConfigMigration({
		...migrationOptions(root),
		backupId: applied.backupId,
	});

	assert.equal(rollback.restored, true);
	assert.equal(rollback.currentVersion, configContentVersion(undefined));
	await assert.rejects(access(userConfigPath(root)));
});

test("migration rollback rejects a concurrent edit and preserves it", async (t) => {
	const root = await temporaryRoot(t);
	await writeUserConfig(root, 'model = "legacy-model"\n');
	const preview = await previewConfigMigration(migrationOptions(root));
	const applied = await applyConfigMigration({
		...migrationOptions(root),
		expectedVersion: preview.expectedVersion,
	});
	assert.ok(applied.backupId);
	const concurrent = '[model]\nname = "concurrent-private-sentinel"\n';
	await writeFile(userConfigPath(root), concurrent, "utf8");

	await assert.rejects(
		() => rollbackConfigMigration({
			...migrationOptions(root),
			backupId: applied.backupId!,
		}),
		(error: unknown) => hasConfigCode(error, "version_conflict"),
	);
	assert.equal(await readFile(userConfigPath(root), "utf8"), concurrent);
});

test("migration validation diagnostics never expose invalid legacy values", async (t) => {
	const root = await temporaryRoot(t);
	await writeLegacyConfig(root, 'memory_enabled = "private-invalid-sentinel"\n');

	await assert.rejects(
		() => previewConfigMigration(migrationOptions(root)),
		(error: unknown) => {
			assert.equal(hasConfigCode(error, "invalid_value"), true);
			assert.doesNotMatch(JSON.stringify(error), /private-invalid-sentinel/u);
			return true;
		},
	);
	await assert.rejects(access(userConfigPath(root)));
});

function migrationOptions(root: TestRoot): ConfigMigrationOptions {
	return {
		...root,
		env: {},
		workspaceTrust: "untrusted",
		now: () => FIXED_DATE,
		createBackupUuid: () => FIXED_UUID,
	};
}

function hasConfigCode(error: unknown, code: string): boolean {
	return isConfigError(error) && error.diagnostic.code === code;
}

async function temporaryRoot(t: TestContext): Promise<TestRoot> {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-migration-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	await Promise.all([mkdir(homeDir), mkdir(workspaceRoot)]);
	t.after(() => rm(root, { recursive: true, force: true }));
	return Object.freeze({ homeDir, workspaceRoot });
}

async function writeUserConfig(root: TestRoot, content: string): Promise<void> {
	await mkdir(join(root.homeDir, ".mycli"), { recursive: true });
	await writeFile(userConfigPath(root), content, "utf8");
}

async function writeLegacyConfig(root: TestRoot, content: string): Promise<void> {
	await mkdir(join(root.homeDir, ".config", "mycli"), { recursive: true });
	await writeFile(legacyConfigPath(root), content, "utf8");
}

async function writeAuth(root: TestRoot, content: string): Promise<void> {
	await mkdir(join(root.homeDir, ".mycli"), { recursive: true });
	await writeFile(authPath(root), content, "utf8");
}

function userConfigPath(root: TestRoot): string {
	return join(root.homeDir, ".mycli", "config.toml");
}

function legacyConfigPath(root: TestRoot): string {
	return join(root.homeDir, ".config", "mycli", "config.toml");
}

function authPath(root: TestRoot): string {
	return join(root.homeDir, ".mycli", "auth.json");
}

function backupDirectory(root: TestRoot): string {
	return join(root.homeDir, ".mycli", "backups", "config");
}
