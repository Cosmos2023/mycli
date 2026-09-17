import { isAbsolute, normalize } from "node:path";
import {
	modelInputSha256,
	stableModelInputJson,
	type ToolDefinition,
} from "@mycli/core";
import { normalizeNetworkDomains, type ExecutionPolicy } from "@mycli/tools";
import type {
	ExecutionPolicyConfiguration,
	TurnExecutionPolicy,
} from "./execution-policy-coordinator.ts";

const SNAPSHOT_VERSION = 1;
const MAX_TOOL_COUNT = 512;
const MAX_TOOL_SCHEMA_BYTES = 512 * 1024;
const MAX_IDENTITY_CHARS = 256;
const MAX_SKILL_CATALOG_CHARS = 256 * 1024;
const MAX_POLICY_LIST_ITEMS = 256;
const MAX_POLICY_ROOT_CHARS = 4_096;
export const TOOL_CATALOG_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const RUN_EXECUTION_SNAPSHOT_MAX_BYTES = 3 * 1024 * 1024;

export interface RunToolCatalogInput {
	readonly catalogVersion: number;
	readonly directTools: readonly ToolDefinition[];
	readonly deferredTools?: readonly ToolDefinition[];
	readonly skillCatalog?: string;
}

export interface ToolCatalogSnapshot {
	readonly version: typeof SNAPSHOT_VERSION;
	readonly catalogVersion: number;
	readonly fingerprint: string;
	readonly directTools: readonly ToolDefinition[];
	readonly deferredTools: readonly ToolDefinition[];
	readonly skillCatalog?: string;
}

export interface RunPolicySnapshot {
	readonly toolsEnabled: boolean;
	readonly profile: ExecutionPolicy;
	readonly configuration?: ExecutionPolicyConfiguration;
}

export interface RunExecutionSnapshot {
	readonly version: typeof SNAPSHOT_VERSION;
	readonly turnId: string;
	readonly collaborationMode: string;
	readonly policy?: RunPolicySnapshot;
	readonly toolCatalog: ToolCatalogSnapshot;
}

export function createToolCatalogSnapshot(input: RunToolCatalogInput): ToolCatalogSnapshot {
	const catalogVersion = nonNegativeInteger(input.catalogVersion, "tool catalog version");
	const directTools = toolDefinitions(input.directTools, "direct tools");
	const deferredTools = toolDefinitions(input.deferredTools ?? [], "deferred tools");
	const skillCatalog = optionalString(input.skillCatalog, "skill catalog", MAX_SKILL_CATALOG_CHARS);
	assertUniqueToolDefinitions([...directTools, ...deferredTools]);
	const fingerprint = catalogFingerprint(catalogVersion, directTools, deferredTools, skillCatalog);
	const snapshot: ToolCatalogSnapshot = Object.freeze({
		version: SNAPSHOT_VERSION,
		catalogVersion,
		fingerprint,
		directTools,
		deferredTools,
		...(skillCatalog ? { skillCatalog } : {}),
	});
	assertSnapshotSize(snapshot, TOOL_CATALOG_SNAPSHOT_MAX_BYTES, "tool catalog snapshot");
	return snapshot;
}

export function createRunExecutionSnapshot(input: {
	readonly turnId: string;
	readonly collaborationMode: string;
	readonly policy?: TurnExecutionPolicy;
	readonly policyConfiguration?: ExecutionPolicyConfiguration;
	readonly toolCatalog: RunToolCatalogInput | ToolCatalogSnapshot;
}): RunExecutionSnapshot {
	const turnId = identity(input.turnId, "turn id");
	const collaborationMode = identity(input.collaborationMode, "collaboration mode", 64);
	const toolCatalog = isToolCatalogSnapshot(input.toolCatalog)
		? parseToolCatalogSnapshot(input.toolCatalog)
		: createToolCatalogSnapshot(input.toolCatalog);
	const snapshot: RunExecutionSnapshot = Object.freeze({
		version: SNAPSHOT_VERSION,
		turnId,
		collaborationMode,
		...(input.policy ? {
			policy: runPolicySnapshot(input.policy, input.policyConfiguration),
		} : {}),
		toolCatalog,
	});
	assertSnapshotSize(snapshot, RUN_EXECUTION_SNAPSHOT_MAX_BYTES, "run execution snapshot");
	return snapshot;
}

export function parseRunExecutionSnapshot(
	value: unknown,
	expectedTurnId?: string,
): RunExecutionSnapshot {
	assertSnapshotSize(value, RUN_EXECUTION_SNAPSHOT_MAX_BYTES, "run execution snapshot");
	const snapshot = record(value, "run execution snapshot");
	if (snapshot.version !== SNAPSHOT_VERSION) {
		throw new TypeError("run execution snapshot version is invalid");
	}
	const turnId = identity(snapshot.turnId, "turn id");
	if (expectedTurnId !== undefined && turnId !== identity(expectedTurnId, "expected turn id")) {
		throw new TypeError("run execution snapshot turn does not match continuation");
	}
	const collaborationMode = identity(snapshot.collaborationMode, "collaboration mode", 64);
	const policy = snapshot.policy === undefined
		? undefined
		: parseRunPolicySnapshot(snapshot.policy);
	const parsed: RunExecutionSnapshot = Object.freeze({
		version: SNAPSHOT_VERSION,
		turnId,
		collaborationMode,
		...(policy ? { policy } : {}),
		toolCatalog: parseToolCatalogSnapshot(snapshot.toolCatalog),
	});
	assertSnapshotSize(parsed, RUN_EXECUTION_SNAPSHOT_MAX_BYTES, "run execution snapshot");
	return parsed;
}

export function replaceRunPolicySnapshot(
	snapshot: RunExecutionSnapshot,
	policy: TurnExecutionPolicy,
): RunExecutionSnapshot {
	const updated: RunExecutionSnapshot = Object.freeze({
		...snapshot,
		policy: runPolicySnapshot(policy, snapshot.policy?.configuration),
	});
	assertSnapshotSize(updated, RUN_EXECUTION_SNAPSHOT_MAX_BYTES, "run execution snapshot");
	return updated;
}

export function toolExposureForSnapshot(
	catalog: ToolCatalogSnapshot,
	activatedToolNames: readonly string[],
): readonly ToolDefinition[] {
	const activated = new Set(activatedToolNames);
	const directNames = new Set(catalog.directTools.map((tool) => tool.name));
	const additions = catalog.deferredTools.filter(
		(tool) => activated.has(tool.name) && !directNames.has(tool.name),
	);
	if (additions.length === 0) return catalog.directTools;
	const tools = [...catalog.directTools, ...additions];
	const isExtension = (tool: ToolDefinition): boolean => tool.id.startsWith("mcp:") || tool.id.startsWith("plugin:");
	// Exposure origin (direct, retained, newly found) must not reorder an unchanged tool set.
	return Object.freeze([
		...tools.filter((tool) => !isExtension(tool)),
		...tools.filter(isExtension).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
	]);
}

function parseToolCatalogSnapshot(value: unknown): ToolCatalogSnapshot {
	assertSnapshotSize(value, TOOL_CATALOG_SNAPSHOT_MAX_BYTES, "tool catalog snapshot");
	const catalog = record(value, "tool catalog snapshot");
	if (catalog.version !== SNAPSHOT_VERSION) {
		throw new TypeError("tool catalog snapshot version is invalid");
	}
	const catalogVersion = nonNegativeInteger(catalog.catalogVersion, "tool catalog version");
	const directTools = toolDefinitions(catalog.directTools, "direct tools");
	const deferredTools = toolDefinitions(catalog.deferredTools, "deferred tools");
	const skillCatalog = optionalString(catalog.skillCatalog, "skill catalog", MAX_SKILL_CATALOG_CHARS);
	assertUniqueToolDefinitions([...directTools, ...deferredTools]);
	const fingerprint = identity(catalog.fingerprint, "tool catalog fingerprint", 64);
	if (!/^[a-f0-9]{64}$/u.test(fingerprint)
		|| fingerprint !== catalogFingerprint(
			catalogVersion,
			directTools,
			deferredTools,
			skillCatalog,
		)) {
		throw new TypeError("tool catalog snapshot fingerprint is invalid");
	}
	const parsed: ToolCatalogSnapshot = Object.freeze({
		version: SNAPSHOT_VERSION,
		catalogVersion,
		fingerprint,
		directTools,
		deferredTools,
		...(skillCatalog ? { skillCatalog } : {}),
	});
	assertSnapshotSize(parsed, TOOL_CATALOG_SNAPSHOT_MAX_BYTES, "tool catalog snapshot");
	return parsed;
}

function catalogFingerprint(
	catalogVersion: number,
	directTools: readonly ToolDefinition[],
	deferredTools: readonly ToolDefinition[],
	skillCatalog?: string,
): string {
	return modelInputSha256({
		version: SNAPSHOT_VERSION,
		catalog_version: catalogVersion,
		direct_tools: directTools,
		deferred_tools: deferredTools,
		...(skillCatalog ? { skill_catalog: skillCatalog } : {}),
	});
}

function runPolicySnapshot(
	policy: TurnExecutionPolicy,
	configuration: ExecutionPolicyConfiguration | undefined,
): RunPolicySnapshot {
	if (typeof policy.toolsEnabled !== "boolean") {
		throw new TypeError("run policy toolsEnabled must be boolean");
	}
	const normalizedConfiguration = configuration
		? executionPolicyConfiguration(configuration)
		: undefined;
	assertPolicyTrust(policy.toolsEnabled, normalizedConfiguration);
	return Object.freeze({
		toolsEnabled: policy.toolsEnabled,
		profile: executionPolicy(policy.profile),
		...(normalizedConfiguration ? { configuration: normalizedConfiguration } : {}),
	});
}

function parseRunPolicySnapshot(value: unknown): RunPolicySnapshot {
	const policy = record(value, "run policy snapshot");
	if (typeof policy.toolsEnabled !== "boolean") {
		throw new TypeError("run policy toolsEnabled must be boolean");
	}
	const configuration = policy.configuration === undefined
		? undefined
		: executionPolicyConfiguration(policy.configuration);
	assertPolicyTrust(policy.toolsEnabled, configuration);
	return Object.freeze({
		toolsEnabled: policy.toolsEnabled,
		profile: executionPolicy(policy.profile),
		...(configuration ? { configuration } : {}),
	});
}

function assertPolicyTrust(
	toolsEnabled: boolean,
	configuration: ExecutionPolicyConfiguration | undefined,
): void {
	if (configuration && toolsEnabled !== (configuration.trust === "trusted")) {
		throw new TypeError("run policy trust does not match toolsEnabled");
	}
}

function executionPolicyConfiguration(value: unknown): ExecutionPolicyConfiguration {
	const configuration = record(value, "execution policy configuration");
	if (configuration.trust !== "trusted"
		&& configuration.trust !== "untrusted"
		&& configuration.trust !== "unknown") {
		throw new TypeError("execution policy trust is invalid");
	}
	if (configuration.permission !== "read-only"
		&& configuration.permission !== "workspace"
		&& configuration.permission !== "full-access") {
		throw new TypeError("execution policy permission is invalid");
	}
	const source = configuration.source;
	if (source !== undefined && source !== "default" && source !== "user"
		&& source !== "project" && source !== "session" && source !== "managed") {
		throw new TypeError("execution policy configuration source is invalid");
	}
	return Object.freeze({
		trust: configuration.trust,
		permission: configuration.permission,
		...(source ? { source } : {}),
	});
}

function executionPolicy(value: unknown): ExecutionPolicy {
	const policy = record(value, "execution policy");
	if (policy.mode !== "read-only"
		&& policy.mode !== "workspace-write"
		&& policy.mode !== "danger-full-access") {
		throw new TypeError("execution policy mode is invalid");
	}
	if (policy.filesystem !== "read_only"
		&& policy.filesystem !== "workspace_write"
		&& policy.filesystem !== "unrestricted") {
		throw new TypeError("execution policy filesystem is invalid");
	}
	if (policy.network !== "disabled" && policy.network !== "enabled") {
		throw new TypeError("execution policy network is invalid");
	}
	const expectedFilesystem = policy.mode === "read-only"
		? "read_only"
		: policy.mode === "workspace-write"
			? "workspace_write"
			: "unrestricted";
	if (policy.filesystem !== expectedFilesystem) {
		throw new TypeError("execution policy mode and filesystem do not match");
	}
	const writableRoots = policyRootList(policy.writableRoots, "writable roots");
	if (policy.filesystem === "read_only" && writableRoots.length > 0) {
		throw new TypeError("read-only execution policy cannot have writable roots");
	}
	if (policy.filesystem === "workspace_write" && writableRoots.length === 0) {
		throw new TypeError("workspace execution policy requires a writable root");
	}
	const networkDomains = policy.networkDomains === undefined
		? undefined
		: normalizeNetworkDomains(stringList(
			policy.networkDomains,
			"network domains",
			MAX_POLICY_LIST_ITEMS,
			253,
		));
	return Object.freeze({
		mode: policy.mode,
		filesystem: policy.filesystem,
		network: policy.network,
		...(networkDomains === undefined ? {} : { networkDomains }),
		...(policy.deniedReadRoots === undefined ? {} : { deniedReadRoots: policyRootList(policy.deniedReadRoots, "denied read roots") }),
		...(policy.deniedReadGlobs === undefined ? {} : { deniedReadGlobs: stringList(policy.deniedReadGlobs, "denied read globs", MAX_POLICY_LIST_ITEMS, 4_096) }),
		...(policy.readableRoots === undefined
			? {}
			: { readableRoots: policyRootList(policy.readableRoots, "readable roots") }),
		writableRoots,
	});
}

function toolDefinitions(value: unknown, label: string): readonly ToolDefinition[] {
	if (!Array.isArray(value) || value.length > MAX_TOOL_COUNT) {
		throw new TypeError(`${label} must be a bounded array`);
	}
	return Object.freeze(value.map((item) => {
		const tool = record(item, "tool definition");
		const inputSchema = record(tool.inputSchema, "tool input schema");
		const serialized = stableModelInputJson(inputSchema);
		if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_SCHEMA_BYTES) {
			throw new TypeError("tool input schema exceeds size limit");
		}
		return Object.freeze({
			id: identity(tool.id, "tool id"),
			name: identity(tool.name, "tool name"),
			description: stringValue(tool.description, "tool description", 64 * 1024),
			inputSchema: deepFreeze(JSON.parse(serialized) as Readonly<Record<string, unknown>>),
		});
	}));
}

function assertUniqueToolDefinitions(tools: readonly ToolDefinition[]): void {
	if (tools.length > MAX_TOOL_COUNT) {
		throw new TypeError("tool catalog exceeds tool count limit");
	}
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const tool of tools) {
		if (ids.has(tool.id)) throw new TypeError(`duplicate run tool id: ${tool.id}`);
		if (names.has(tool.name)) throw new TypeError(`duplicate run tool: ${tool.name}`);
		ids.add(tool.id);
		names.add(tool.name);
	}
}

function stringList(
	value: unknown,
	label: string,
	maxItems = MAX_POLICY_LIST_ITEMS,
	maxChars = MAX_POLICY_ROOT_CHARS,
): readonly string[] {
	if (!Array.isArray(value) || value.length > maxItems) {
		throw new TypeError(`${label} must be a bounded array`);
	}
	return Object.freeze(value.map((item) => identity(item, label, maxChars)));
}

function policyRootList(value: unknown, label: string): readonly string[] {
	const roots = stringList(value, label);
	if (roots.some((root) => !isAbsolute(root) || normalize(root) !== root)) {
		throw new TypeError(`${label} must contain normalized absolute paths`);
	}
	if (new Set(roots).size !== roots.length) {
		throw new TypeError(`${label} must not contain duplicates`);
	}
	return roots;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value as Readonly<Record<string, unknown>>;
}

function identity(value: unknown, label: string, maxChars = MAX_IDENTITY_CHARS): string {
	return stringValue(value, label, maxChars, true);
}

function stringValue(
	value: unknown,
	label: string,
	maxChars: number,
	trim = false,
): string {
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
	const result = trim ? value.trim() : value;
	if (!result || result.length > maxChars || result.includes("\0")) {
		throw new TypeError(`${label} is invalid`);
	}
	return result;
}

function optionalString(
	value: unknown,
	label: string,
	maxChars: number,
): string | undefined {
	if (value === undefined || value === "") return undefined;
	return stringValue(value, label, maxChars);
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw new TypeError(`${label} must be a non-negative integer`);
	}
	return Number(value);
}

function isToolCatalogSnapshot(
	value: RunToolCatalogInput | ToolCatalogSnapshot,
): value is ToolCatalogSnapshot {
	return "version" in value;
}

function assertSnapshotSize(value: unknown, maximumBytes: number, label: string): void {
	let serialized: string;
	try {
		serialized = stableModelInputJson(value);
	} catch {
		throw new TypeError(`${label} is invalid`);
	}
	if (typeof serialized !== "string") throw new TypeError(`${label} is invalid`);
	if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
		throw new TypeError(`${label} exceeds size limit`);
	}
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}
