import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { posix, relative, resolve, sep, win32 } from "node:path";
import test from "node:test";
import { SHELL_SETTING_DESCRIPTORS } from "@mycli/config";
import { gatewayContractCatalog } from "@mycli/contracts";
import { ROOT_HELP } from "../src/cli.ts";
import { MANAGEMENT_COMMAND_NAMES } from "../src/management/parser.ts";
import { slashCommandParityMatrix } from "../src/node-runtime/node-slash-command-registry.ts";

type SupportedPlatform = "darwin" | "linux" | "win32";

interface TestEvidence {
	readonly file: string;
	readonly test: string;
}

interface JourneyBaseline {
	readonly id: string;
	readonly platforms: readonly SupportedPlatform[];
	readonly evidence: readonly TestEvidence[];
}

interface DriftEvidence extends TestEvidence {
	readonly id: string;
}

interface UxBaselineManifest {
	readonly schema_version: 1;
	readonly supported_platforms: readonly SupportedPlatform[];
	readonly journeys: readonly JourneyBaseline[];
	readonly measurements: {
		readonly first_paint: {
			readonly awaited_network_operations: number;
			readonly wall_clock_mode: string;
			readonly wall_clock_ci_asserted: boolean;
		};
		readonly ready_composer: {
			readonly configured_trusted_confirmation_steps: number;
			readonly fresh_install_confirmation_steps: number;
			readonly credential_text_entries: number;
		};
	};
	readonly budgets: {
		readonly awaited_network_operations_before_first_paint: number;
		readonly primary_diagnostics_per_root_failure: number;
		readonly selector_filter_response_ms: number;
		readonly minimum_terminal_columns: number;
		readonly destructive_action_default: string;
		readonly pending_selector_escape: string;
		readonly composer_draft_on_cancel: string;
		readonly pty_readiness_ms: number;
	};
	readonly drift_evidence: readonly DriftEvidence[];
	readonly privacy: {
		readonly recorded_fields: readonly string[];
		readonly excluded_content: readonly string[];
		readonly absolute_paths_allowed: boolean;
		readonly secret_like_values_allowed: boolean;
	};
	readonly report: string;
}

interface GatewayAuditFixture {
	readonly gateway: {
		readonly rpc_count: number;
		readonly event_count: number;
		readonly required_rpc: readonly string[];
		readonly required_events: readonly string[];
	};
}

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const EXPECTED_PLATFORMS = ["darwin", "linux", "win32"] as const;
const EXPECTED_JOURNEYS = [
	"fresh_install",
	"missing_credential",
	"malformed_user_config",
	"untrusted_project_config",
	"session_model_scope",
	"permission_switch",
	"resume_repair",
	"narrow_cjk_ime",
	"windows_sandbox_readiness",
] as const;
const EXPECTED_DRIFT_SURFACES = [
	"management_help_docs",
	"slash_registry_docs",
	"settings_catalog",
	"gateway_contracts",
] as const;
const SECRET_LIKE_VALUE = /(?:^|[\s"'=])(?:sk|rk|pk)-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._~-]{12,}|(?:api[_ -]?key|token|secret)\s*[:=]\s*[^\s,}]{4,}/iu;
const USER_ABSOLUTE_PATH = /(?:\/Users\/[^/\s`]+|\/home\/[^/\s`]+|[a-z]:\\Users\\[^\\\s`]+)/iu;

const manifest = parseManifest(readJson("tests/fixtures/configuration_ux/baseline.json"));

test("UX baseline manifest is versioned, ordered, and privacy-safe", () => {
	assert.equal(manifest.schema_version, 1);
	assert.deepEqual(manifest.supported_platforms, EXPECTED_PLATFORMS);
	assert.deepEqual(manifest.journeys.map((journey) => journey.id), EXPECTED_JOURNEYS);
	assert.deepEqual(manifest.drift_evidence.map((row) => row.id), EXPECTED_DRIFT_SURFACES);
	assert.deepEqual(manifest.budgets, {
		awaited_network_operations_before_first_paint: 0,
		primary_diagnostics_per_root_failure: 1,
		selector_filter_response_ms: 100,
		minimum_terminal_columns: 60,
		destructive_action_default: "cancel",
		pending_selector_escape: "required",
		composer_draft_on_cancel: "preserve",
		pty_readiness_ms: 5_000,
	});
	assert.deepEqual(manifest.measurements, {
		first_paint: {
			awaited_network_operations: 0,
			wall_clock_mode: "local_opt_in",
			wall_clock_ci_asserted: false,
		},
		ready_composer: {
			configured_trusted_confirmation_steps: 0,
			fresh_install_confirmation_steps: 7,
			credential_text_entries: 1,
		},
	});
	assert.equal(
		manifest.measurements.first_paint.awaited_network_operations,
		manifest.budgets.awaited_network_operations_before_first_paint,
	);
	assert.deepEqual(manifest.privacy, {
		recorded_fields: [
			"journey_id",
			"platform",
			"relative_test_file",
			"test_name",
			"stage_name",
			"elapsed_milliseconds",
			"interaction_steps",
		],
		excluded_content: [
			"credentials",
			"prompts",
			"tool content",
			"provider output",
			"absolute user paths",
		],
		absolute_paths_allowed: false,
		secret_like_values_allowed: false,
	});

	const platformCoverage = new Set(manifest.journeys.flatMap((journey) => journey.platforms));
	assert.deepEqual([...platformCoverage].sort(), [...EXPECTED_PLATFORMS].sort());
	for (const value of stringsIn(manifest)) {
		assert.equal(posix.isAbsolute(value), false, `POSIX absolute path: ${value}`);
		assert.equal(win32.isAbsolute(value), false, `Windows absolute path: ${value}`);
		assert.doesNotMatch(value, SECRET_LIKE_VALUE);
	}
});

test("UX baseline evidence resolves to exact provider-free test declarations", () => {
	const evidence = [
		...manifest.journeys.flatMap((journey) => journey.evidence),
		...manifest.drift_evidence,
	];
	assert.ok(evidence.length >= EXPECTED_JOURNEYS.length);
	for (const row of evidence) assertTestEvidence(row);

	const reportPath = repositoryPath(manifest.report);
	const report = readFileSync(reportPath, "utf8");
	assert.match(report, /Provider-free journey baseline/u);
	assert.doesNotMatch(report, SECRET_LIKE_VALUE);
	assert.doesNotMatch(report, USER_ABSOLUTE_PATH);
});

test("management parser, root help, and command documentation stay aligned", () => {
	const helpCommands = [...commandSection(ROOT_HELP).matchAll(/^ {2}([a-z][a-z-]*)\b/gmu)]
		.map((match) => match[1]);
	assert.deepEqual(helpCommands, [...MANAGEMENT_COMMAND_NAMES]);

	const docs = readFileSync(repositoryPath("docs/commands.md"), "utf8");
	const documented = [...docs.matchAll(/^\| `mycli ([a-z][a-z-]*)(?: [^`]*)?` \|/gmu)]
		.map((match) => match[1]);
	assert.deepEqual(documented, [...MANAGEMENT_COMMAND_NAMES]);
});

test("slash commands, settings, and gateway evidence stay aligned", () => {
	const docs = readFileSync(repositoryPath("docs/commands.md"), "utf8");
	const matrix = slashCommandParityMatrix();
	assert.ok(Array.isArray(matrix.commands));
	assert.ok(Array.isArray(matrix.prefixed_aliases));
	for (const value of matrix.commands) {
		assertRecord(value, "slash command");
		assert.equal(typeof value.name, "string");
		assert.ok(docs.includes(`| \`${value.name}\` |`), String(value.name));
		assert.ok(Array.isArray(value.aliases));
		for (const alias of value.aliases) {
			assert.equal(typeof alias, "string");
			assert.ok(docs.includes(`\`${alias}\``), alias);
		}
	}
	for (const value of matrix.prefixed_aliases) {
		assertRecord(value, "prefixed slash alias");
		assert.equal(typeof value.prefix, "string");
		assert.ok(docs.includes(`\`${value.prefix}\``), String(value.prefix));
	}
	for (const descriptor of SHELL_SETTING_DESCRIPTORS) {
		assert.ok(docs.includes(`\`${descriptor.key}\``), descriptor.key);
	}

	const audit = readJson(
		"backend/apps/mycli/test/fixtures/node-runtime-m8-capability-audit.json",
	) as GatewayAuditFixture;
	assert.equal(gatewayContractCatalog.rpcMethods.length, audit.gateway.rpc_count);
	assert.equal(gatewayContractCatalog.eventStreams.length, audit.gateway.event_count);
	for (const method of audit.gateway.required_rpc) {
		assert.ok(gatewayContractCatalog.rpcMethods.includes(method), method);
	}
	for (const event of audit.gateway.required_events) {
		assert.ok(gatewayContractCatalog.eventStreams.includes(event), event);
	}
});

function parseManifest(value: unknown): UxBaselineManifest {
	assertRecord(value, "UX baseline manifest");
	assert.deepEqual(Object.keys(value), [
		"schema_version",
		"supported_platforms",
		"journeys",
		"measurements",
		"budgets",
		"drift_evidence",
		"privacy",
		"report",
	]);
	assert.equal(value.schema_version, 1);
	assertStringArray(value.supported_platforms, "supported_platforms");
	assert.ok(Array.isArray(value.journeys));
	for (const [index, journey] of value.journeys.entries()) {
		assertRecord(journey, `journeys[${index}]`);
		assert.deepEqual(Object.keys(journey), ["id", "platforms", "evidence"]);
		assert.equal(typeof journey.id, "string");
		assertStringArray(journey.platforms, `journeys[${index}].platforms`);
		assert.ok(journey.platforms.length > 0);
		for (const platform of journey.platforms) {
			assert.ok(EXPECTED_PLATFORMS.includes(platform as SupportedPlatform), String(platform));
		}
		assertEvidenceArray(journey.evidence, `journeys[${index}].evidence`);
	}
	assertRecord(value.measurements, "measurements");
	assertRecord(value.measurements.first_paint, "measurements.first_paint");
	assertRecord(value.measurements.ready_composer, "measurements.ready_composer");
	assertRecord(value.budgets, "budgets");
	assert.ok(Array.isArray(value.drift_evidence));
	for (const [index, row] of value.drift_evidence.entries()) {
		assertRecord(row, `drift_evidence[${index}]`);
		assert.deepEqual(Object.keys(row), ["id", "file", "test"]);
		assert.equal(typeof row.id, "string");
		assertEvidence(row, `drift_evidence[${index}]`);
	}
	assertRecord(value.privacy, "privacy");
	assertStringArray(value.privacy.recorded_fields, "privacy.recorded_fields");
	assertStringArray(value.privacy.excluded_content, "privacy.excluded_content");
	assert.equal(typeof value.privacy.absolute_paths_allowed, "boolean");
	assert.equal(typeof value.privacy.secret_like_values_allowed, "boolean");
	assert.equal(typeof value.report, "string");
	return value as unknown as UxBaselineManifest;
}

function assertEvidenceArray(value: unknown, label: string): asserts value is TestEvidence[] {
	assert.ok(Array.isArray(value), `${label} must be an array`);
	assert.ok(value.length > 0, `${label} must not be empty`);
	for (const [index, row] of value.entries()) {
		assertRecord(row, `${label}[${index}]`);
		assert.deepEqual(Object.keys(row), ["file", "test"]);
		assertEvidence(row, `${label}[${index}]`);
	}
}

function assertEvidence(
	value: Record<string, unknown>,
	label: string,
): asserts value is Record<string, unknown> & TestEvidence {
	const file = value.file;
	const testName = value.test;
	if (typeof file !== "string") assert.fail(`${label}.file must be a string`);
	if (typeof testName !== "string") assert.fail(`${label}.test must be a string`);
	assert.ok(file.length > 0, `${label}.file`);
	assert.ok(testName.length > 0, `${label}.test`);
}

function assertTestEvidence(evidence: TestEvidence): void {
	assert.equal(evidence.file.includes("\\"), false, evidence.file);
	assert.equal(posix.normalize(evidence.file), evidence.file);
	const source = readFileSync(repositoryPath(evidence.file), "utf8");
	const declaration = new RegExp(
		`\\btest\\s*\\(\\s*${escapeRegExp(JSON.stringify(evidence.test))}`,
		"u",
	);
	assert.match(source, declaration, `${evidence.file}: ${evidence.test}`);
}

function commandSection(help: string): string {
	const commands = help.split("Commands:\n", 2)[1];
	assert.ok(commands, "root help must contain a Commands section");
	return commands.split("Options:\n", 1)[0] ?? "";
}

function repositoryPath(path: string): string {
	assert.equal(posix.isAbsolute(path), false, path);
	assert.equal(win32.isAbsolute(path), false, path);
	const resolved = resolve(ROOT, path);
	const fromRoot = relative(ROOT, resolved);
	assert.equal(fromRoot === ".." || fromRoot.startsWith(`..${sep}`), false, path);
	return resolved;
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(repositoryPath(path), "utf8")) as unknown;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
	assert.equal(typeof value, "object", `${label} must be an object`);
	assert.notEqual(value, null, `${label} must be an object`);
	assert.equal(Array.isArray(value), false, `${label} must be an object`);
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
	assert.ok(Array.isArray(value), `${label} must be an array`);
	for (const item of value) assert.equal(typeof item, "string", label);
}

function stringsIn(value: unknown): readonly string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(stringsIn);
	if (typeof value !== "object" || value === null) return [];
	return Object.values(value).flatMap(stringsIn);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
