import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "@decimalturn/toml-patch";
import {
	configError,
	isConfigError,
	type ConfigDiagnostic,
} from "./config-diagnostics.ts";
import type { ConfigLayerId } from "./config-layers.ts";
import { atomicPrivateFileUpdate } from "./private-file-writer.ts";
import {
	configSettingDescriptors,
	runtimeSettingSnapshots,
	type ConfigSettingDescriptor,
	type UserConfigScalar,
} from "./runtime-setting-catalog.ts";
import {
	resolveConfigWithUserConfigText,
	type ResolveConfigOptions,
} from "./settings.ts";
import { shellSettingDescriptor } from "./shell-setting-catalog.ts";
import {
	buildUserConfigCandidate,
	validateUserConfigCandidate,
	type UserConfigEdit,
} from "./user-config-editor.ts";

export const CONFIG_MIGRATION_VERSION = 1 as const;

const CONFIG_BACKUP_VERSION = 1 as const;
const MAX_MIGRATION_CHANGES = 64;
const BACKUP_ID_PATTERN = /^\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ConfigMigrationChangeKind = "import" | "normalize";

export interface ConfigMigrationChange {
	readonly key: string;
	readonly kind: ConfigMigrationChangeKind;
	readonly source: "user" | "legacy_user";
	readonly effectiveSource: ConfigLayerId | "default";
	readonly overridden: readonly ConfigLayerId[];
}

export interface ConfigMigrationPreview {
	readonly version: typeof CONFIG_MIGRATION_VERSION;
	readonly needed: boolean;
	readonly expectedVersion: string;
	readonly currentVersion: string;
	readonly legacyVersion: string;
	readonly resultingVersion: string;
	readonly changes: readonly ConfigMigrationChange[];
	readonly truncated: boolean;
	readonly diagnostics: readonly ConfigDiagnostic[];
}

export interface ConfigMigrationApplyResult extends ConfigMigrationPreview {
	readonly applied: boolean;
	readonly backupId?: string;
}

export interface ConfigMigrationRollbackResult {
	readonly version: typeof CONFIG_MIGRATION_VERSION;
	readonly restored: boolean;
	readonly backupId: string;
	readonly currentVersion: string;
	readonly diagnostics: readonly ConfigDiagnostic[];
}

export interface ConfigMigrationOptions extends ResolveConfigOptions {
	readonly now?: () => Date;
	readonly createBackupUuid?: () => string;
	readonly failpoint?: (name: string) => void;
}

export interface ApplyConfigMigrationOptions extends ConfigMigrationOptions {
	readonly expectedVersion: string;
}

export interface RollbackConfigMigrationOptions extends ConfigMigrationOptions {
	readonly backupId: string;
}

interface PendingChange {
	readonly key: string;
	readonly kind: ConfigMigrationChangeKind;
	readonly source: "user" | "legacy_user";
}

interface InternalMigrationPlan {
	readonly preview: ConfigMigrationPreview;
	readonly candidate: string;
	readonly current: string | undefined;
}

interface ConfigBackupRecord {
	readonly version: typeof CONFIG_BACKUP_VERSION;
	readonly id: string;
	readonly createdAt: string;
	readonly beforeExisted: boolean;
	readonly beforeContentBase64: string;
	readonly beforeVersion: string;
	readonly afterVersion: string;
	readonly migrationVersion: string;
}

type ConfigMap = Record<string, unknown>;

export async function previewConfigMigration(
	options: ConfigMigrationOptions,
): Promise<ConfigMigrationPreview> {
	return (await buildMigrationPlan(options)).preview;
}

export async function applyConfigMigration(
	options: ApplyConfigMigrationOptions,
): Promise<ConfigMigrationApplyResult> {
	try {
		return await applyConfigMigrationTransaction(options);
	} catch (error) {
		if (isConfigError(error)) throw error;
		throw configWriteFailure();
	}
}

async function applyConfigMigrationTransaction(
	options: ApplyConfigMigrationOptions,
): Promise<ConfigMigrationApplyResult> {
	let plan: InternalMigrationPlan | undefined;
	let backupId: string | undefined;
	const changed = await atomicPrivateFileUpdate({
		directory: userConfigDirectory(options.homeDir),
		fileName: "config.toml",
		buildContent: async (current) => {
			const legacy = await readOptionalConfig(legacyConfigPath(options.homeDir), "legacy_user");
			plan = await buildMigrationPlan(options, current, legacy);
			if (plan.preview.expectedVersion !== options.expectedVersion) {
				throw versionConflict();
			}
			if (!plan.preview.needed) return undefined;
			backupId = createBackupId(options);
			return plan.candidate;
		},
		prepareCommit: async ({ current, content }) => {
			if (!plan || !backupId || content === null) {
				throw configWriteFailure();
			}
			await writeBackup(options, Object.freeze({
				version: CONFIG_BACKUP_VERSION,
				id: backupId,
				createdAt: (options.now?.() ?? new Date()).toISOString(),
				beforeExisted: current !== undefined,
				beforeContentBase64: Buffer.from(current ?? "", "utf8").toString("base64"),
				beforeVersion: configContentVersion(current),
				afterVersion: configContentVersion(content),
				migrationVersion: plan.preview.expectedVersion,
			}));
		},
		...(options.failpoint ? { failpoint: options.failpoint } : {}),
	});
	if (!plan) throw configWriteFailure();
	return Object.freeze({
		...plan.preview,
		applied: changed,
		...(changed && backupId ? { backupId } : {}),
	});
}

export async function rollbackConfigMigration(
	options: RollbackConfigMigrationOptions,
): Promise<ConfigMigrationRollbackResult> {
	try {
		return await rollbackConfigMigrationTransaction(options);
	} catch (error) {
		if (isConfigError(error)) throw error;
		throw configWriteFailure();
	}
}

async function rollbackConfigMigrationTransaction(
	options: RollbackConfigMigrationOptions,
): Promise<ConfigMigrationRollbackResult> {
	const backup = await readBackup(options);
	const before = decodeBackupContent(backup);
	let diagnostics: readonly ConfigDiagnostic[] = Object.freeze([]);
	const restored = await atomicPrivateFileUpdate({
		directory: userConfigDirectory(options.homeDir),
		fileName: "config.toml",
		buildContent: async (current) => {
			if (configContentVersion(current) !== backup.afterVersion) throw versionConflict();
			const candidate = backup.beforeExisted ? before : "";
			await validateUserConfigCandidate(options, candidate);
			diagnostics = (await resolveConfigWithUserConfigText(options, candidate)).diagnostics;
			return backup.beforeExisted ? before : null;
		},
		...(options.failpoint ? { failpoint: options.failpoint } : {}),
	});
	return Object.freeze({
		version: CONFIG_MIGRATION_VERSION,
		restored,
		backupId: backup.id,
		currentVersion: backup.beforeVersion,
		diagnostics: Object.freeze([...diagnostics]),
	});
}

export function configContentVersion(content: string | undefined): string {
	const state = content === undefined ? "absent" : "present";
	const digest = createHash("sha256").update(content ?? "", "utf8").digest("hex");
	return `config-v1-${state}-${digest}`;
}

async function buildMigrationPlan(
	options: ConfigMigrationOptions,
	currentOverride?: string,
	legacyOverride?: string,
): Promise<InternalMigrationPlan> {
	const [current, legacy] = await Promise.all([
		currentOverride === undefined
			? readOptionalConfig(userConfigPath(options.homeDir), "user")
			: Promise.resolve(currentOverride),
		legacyOverride === undefined
			? readOptionalConfig(legacyConfigPath(options.homeDir), "legacy_user")
			: Promise.resolve(legacyOverride),
	]);
	const source = current ?? "";
	await resolveConfigWithUserConfigText(options, source);
	const { edits, changes } = migrationEdits(source, legacy ?? "");
	const candidate = buildUserConfigCandidate(source, edits);
	await validateUserConfigCandidate(options, candidate);
	const resolved = await resolveConfigWithUserConfigText(options, candidate);
	const projected = projectChanges(changes, resolved);
	const currentVersion = configContentVersion(current);
	const legacyVersion = configContentVersion(legacy);
	const expectedVersion = migrationPlanVersion(currentVersion, legacyVersion);
	const resultingVersion = candidate === source && current === undefined
		? currentVersion
		: configContentVersion(candidate);
	return Object.freeze({
		candidate,
		current,
		preview: Object.freeze({
			version: CONFIG_MIGRATION_VERSION,
			needed: candidate !== source,
			expectedVersion,
			currentVersion,
			legacyVersion,
			resultingVersion,
			changes: Object.freeze(projected.slice(0, MAX_MIGRATION_CHANGES)),
			truncated: projected.length > MAX_MIGRATION_CHANGES,
			diagnostics: Object.freeze([...resolved.diagnostics]),
		}),
	});
}

function migrationEdits(
	userSource: string,
	legacySource: string,
): { readonly edits: readonly UserConfigEdit[]; readonly changes: readonly PendingChange[] } {
	const user = parseConfigMap(userSource);
	const legacy = parseConfigMap(legacySource);
	const edits: UserConfigEdit[] = [];
	const changes: PendingChange[] = [];
	for (const setting of configSettingDescriptors()) {
		if (!setting.writable) continue;
		const canonicalUser = scalarAtPath(user, setting.path);
		const userAliases = scalarAliases(user, setting);
		if (canonicalUser !== undefined || userAliases.length > 0) {
			for (const alias of userAliases) edits.push(clearAlias(alias, setting.path));
			if (canonicalUser === undefined && userAliases[0]) {
				edits.push({ action: "set", path: setting.path, value: userAliases[0].value });
			}
			if (userAliases.length > 0) {
				changes.push({ key: setting.key, kind: "normalize", source: "user" });
			}
			continue;
		}
		const legacyValue = scalarAtPath(legacy, setting.path)
			?? scalarAliases(legacy, setting)[0]?.value;
		if (legacyValue === undefined) continue;
		edits.push({ action: "set", path: setting.path, value: legacyValue });
		changes.push({ key: setting.key, kind: "import", source: "legacy_user" });
	}
	return Object.freeze({ edits: Object.freeze(edits), changes: Object.freeze(changes) });
}

function projectChanges(
	changes: readonly PendingChange[],
	resolved: Awaited<ReturnType<typeof resolveConfigWithUserConfigText>>,
): readonly ConfigMigrationChange[] {
	const runtime = new Map(runtimeSettingSnapshots(resolved.config).map((setting) => [setting.key, setting]));
	return Object.freeze(changes.map((change) => {
		const shell = shellSettingDescriptor(change.key);
		if (shell) {
			return Object.freeze({
				...change,
				effectiveSource: resolved.shellSettings.sources[shell.settingKey],
				overridden: resolved.shellSettings.overridden[shell.settingKey],
			});
		}
		const setting = runtime.get(change.key);
		const origin = setting?.originKeys
			.map((key) => resolved.layers.origins[key])
			.find((candidate) => candidate !== undefined);
		return Object.freeze({
			...change,
			effectiveSource: origin?.source.id ?? "default",
			overridden: Object.freeze(origin?.overridden.map((layer) => layer.id) ?? []),
		});
	}));
}

function scalarAliases(
	payload: ConfigMap,
	setting: ConfigSettingDescriptor,
): readonly { readonly path: readonly string[]; readonly value: UserConfigScalar }[] {
	return Object.freeze(setting.legacyPaths.flatMap((path) => {
		if (samePath(path, setting.path)) return [];
		const value = valueAtPath(payload, path);
		if (!isScalar(value)) return [];
		return [{ path, value }];
	}));
}

function clearAlias(alias: { readonly path: readonly string[] }, canonical: readonly string[]): UserConfigEdit {
	return {
		action: "clear",
		path: alias.path,
		...(isPathPrefix(alias.path, canonical) ? { onlyIfScalar: true } : {}),
	};
}

async function writeBackup(
	options: ConfigMigrationOptions,
	record: ConfigBackupRecord,
): Promise<void> {
	await atomicPrivateFileUpdate({
		directory: backupDirectory(options.homeDir),
		fileName: `${record.id}.json`,
		buildContent: (current) => {
			if (current !== undefined) throw configWriteFailure();
			return `${JSON.stringify(record)}\n`;
		},
	});
}

async function readBackup(options: RollbackConfigMigrationOptions): Promise<ConfigBackupRecord> {
	if (!BACKUP_ID_PATTERN.test(options.backupId)) throw invalidBackup();
	let raw: string;
	try {
		raw = await readFile(join(backupDirectory(options.homeDir), `${options.backupId}.json`), "utf8");
	} catch {
		throw invalidBackup();
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw invalidBackup();
	}
	if (!isBackupRecord(value) || value.id !== options.backupId) throw invalidBackup();
	const before = decodeBackupContent(value);
	const expectedBefore = configContentVersion(value.beforeExisted ? before : undefined);
	if (expectedBefore !== value.beforeVersion) throw invalidBackup();
	return Object.freeze(value);
}

function decodeBackupContent(record: ConfigBackupRecord): string {
	const buffer = Buffer.from(record.beforeContentBase64, "base64");
	if (buffer.toString("base64") !== record.beforeContentBase64) throw invalidBackup();
	return buffer.toString("utf8");
}

function isBackupRecord(value: unknown): value is ConfigBackupRecord {
	if (!isRecord(value)) return false;
	return value.version === CONFIG_BACKUP_VERSION
		&& typeof value.id === "string"
		&& BACKUP_ID_PATTERN.test(value.id)
		&& typeof value.createdAt === "string"
		&& Number.isFinite(Date.parse(value.createdAt))
		&& typeof value.beforeExisted === "boolean"
		&& typeof value.beforeContentBase64 === "string"
		&& isContentVersion(value.beforeVersion)
		&& isContentVersion(value.afterVersion)
		&& isMigrationVersion(value.migrationVersion);
}

function createBackupId(options: ConfigMigrationOptions): string {
	const timestamp = (options.now?.() ?? new Date()).toISOString().replace(/[-:.]/gu, "");
	const id = `${timestamp}-${options.createBackupUuid?.() ?? randomUUID()}`;
	if (!BACKUP_ID_PATTERN.test(id)) throw configWriteFailure();
	return id;
}

function migrationPlanVersion(currentVersion: string, legacyVersion: string): string {
	const digest = createHash("sha256")
		.update(`${CONFIG_MIGRATION_VERSION}\0${currentVersion}\0${legacyVersion}`, "utf8")
		.digest("hex");
	return `migration-v1-${digest}`;
}

function parseConfigMap(source: string): ConfigMap {
	const value: unknown = parseDocument(source).toJsObject;
	if (!isRecord(value)) throw configWriteFailure();
	return value;
}

function scalarAtPath(payload: ConfigMap, path: readonly string[]): UserConfigScalar | undefined {
	const value = valueAtPath(payload, path);
	return isScalar(value) ? value : undefined;
}

function valueAtPath(payload: ConfigMap, path: readonly string[]): unknown {
	let value: unknown = payload;
	for (const segment of path) {
		if (!isRecord(value)) return undefined;
		value = value[segment];
	}
	return value;
}

async function readOptionalConfig(
	path: string,
	layer: "user" | "legacy_user",
): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return undefined;
		throw configError({
			code: "config_read_failed",
			severity: "error",
			layer,
			message: `${layer === "user" ? "user" : "legacy user"} config could not be read`,
			remediation: "Check that the config file is readable and try again.",
		});
	}
}

function invalidBackup(): Error {
	return configError({
		code: "migration_backup_invalid",
		severity: "error",
		layer: "user",
		message: "configuration migration backup is invalid or unavailable",
		remediation: "Use the backup id returned by a completed migration apply operation.",
	});
}

function versionConflict(): Error {
	return configError({
		code: "version_conflict",
		severity: "error",
		layer: "user",
		message: "user configuration changed after the migration preview",
		remediation: "Run 'mycli config migrate --dry-run' again before applying or rolling back.",
	});
}

function configWriteFailure(): Error {
	return configError({
		code: "config_write_failed",
		severity: "error",
		layer: "user",
		message: "user config migration could not be completed",
		remediation: "Check private configuration storage permissions and try again.",
	});
}

function isContentVersion(value: unknown): value is string {
	return typeof value === "string" && /^config-v1-(?:present|absent)-[0-9a-f]{64}$/u.test(value);
}

function isMigrationVersion(value: unknown): value is string {
	return typeof value === "string" && /^migration-v1-[0-9a-f]{64}$/u.test(value);
}

function isScalar(value: unknown): value is UserConfigScalar {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is ConfigMap {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function isPathPrefix(prefix: readonly string[], path: readonly string[]): boolean {
	return prefix.length < path.length && prefix.every((segment, index) => segment === path[index]);
}

function userConfigDirectory(homeDir: string): string {
	return join(homeDir, ".mycli");
}

function userConfigPath(homeDir: string): string {
	return join(userConfigDirectory(homeDir), "config.toml");
}

function legacyConfigPath(homeDir: string): string {
	return join(homeDir, ".config", "mycli", "config.toml");
}

function backupDirectory(homeDir: string): string {
	return join(userConfigDirectory(homeDir), "backups", "config");
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
