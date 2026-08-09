import { join } from "node:path";
import {
	builtinSkillRoot as defaultBuiltinSkillRoot,
	HookManagementService,
	McpClient,
	McpManagementService,
	PluginManagementService,
	SkillRegistry,
} from "@mycli/integrations";
import type {
	LoadedPluginManifest,
	McpManagedClient,
	McpServerConfig,
	PluginHostContract,
} from "@mycli/integrations";
import {
	pluginSandboxProfile,
	workspaceSandboxProfile,
} from "../../node-runtime/integration-sandbox.ts";
import type { DoctorCheck, DoctorStatus } from "./types.ts";

export interface ExtensionDoctorOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly builtinSkillRoot?: string;
	readonly createPluginHost?: (manifest: LoadedPluginManifest) => PluginHostContract;
	readonly createMcpClient?: (config: McpServerConfig) => McpManagedClient;
}

export async function collectExtensionChecks(
	options: ExtensionDoctorOptions,
	signal: AbortSignal,
): Promise<readonly DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	checks.push(await isolated("hooks", () => checkHooks(options)));
	const pluginChecks = await isolatedMany(
		["plugins", "plugin_migration"],
		() => checkPlugins(options, signal),
	);
	checks.push(...pluginChecks);
	checks.push(await isolated("skills", () => checkSkills(options)));
	checks.push(check("subagents", "ok", "mode=prompt_driven profiles=disabled"));
	checks.push(await isolated("mcp", () => checkMcp(options, signal)));
	return Object.freeze(checks);
}

async function checkHooks(options: ExtensionDoctorOptions): Promise<DoctorCheck> {
	const response = await new HookManagementService(options).list();
	const approvalWarnings = response.hooks.filter((hook) => (
		!hook.enabled
		|| hook.envPolicy === "inherit_safe"
		|| hook.allowlistStatus !== "allowed"
	)).length;
	const status: DoctorStatus = response.issues.length > 0
		? "failed"
		: approvalWarnings > 0
			? "warning"
			: "ok";
	return check(
		"hooks",
		status,
		`configured=${response.hooks.length} issues=${response.issues.length} approval_warnings=${approvalWarnings}`,
		issueCategories(response.issues),
	);
}

async function checkPlugins(
	options: ExtensionDoctorOptions,
	signal: AbortSignal,
): Promise<readonly DoctorCheck[]> {
	const response = await new PluginManagementService({
		runtimeOptions: {
			workspaceRoot: options.workspaceRoot,
			homeDir: options.homeDir,
			env: options.env,
			sandboxProfile: pluginSandboxProfile,
			...(options.createPluginHost ? { createHost: options.createPluginHost } : {}),
		},
	}).list(signal);
	const migrations = response.plugins.filter((plugin) => plugin.status === "migration_required");
	const errors = response.plugins.filter((plugin) => plugin.status === "error");
	const loaded = response.plugins.filter((plugin) => plugin.status === "loaded");
	return Object.freeze([
		check(
			"plugins",
			!response.ok || errors.length > 0 ? "failed" : "ok",
			`discovered=${response.plugins.length} loaded=${loaded.length} failed=${errors.length}`,
			issueCategories(errors.flatMap((plugin) => plugin.issues)),
		),
		check(
			"plugin_migration",
			migrations.length > 0 ? "warning" : "ok",
			migrations.length > 0
				? `migration_required=${migrations.length}; see docs/migration/python-plugins-to-v2.md`
				: "migration_required=0",
		),
	]);
}

async function checkSkills(options: ExtensionDoctorOptions): Promise<DoctorCheck> {
	const registry = await SkillRegistry.discover({
		builtinRoot: options.builtinSkillRoot ?? defaultBuiltinSkillRoot(),
		userRoot: join(options.homeDir, ".mycli", "skills"),
		sharedRepoRoot: join(options.workspaceRoot, ".agents", "skills"),
		repoRoot: join(options.workspaceRoot, ".mycli", "skills"),
	});
	const diagnostics = registry.diagnostics();
	return check(
		"skills",
		diagnostics.issueCount > 0 ? "warning" : "ok",
		`loaded=${diagnostics.loadedCount} issues=${diagnostics.issueCount} duplicates=${diagnostics.duplicateCount}`,
		diagnosticClasses(diagnostics.issues.map((issue) => issue.errorClass)),
	);
}

async function checkMcp(
	options: ExtensionDoctorOptions,
	signal: AbortSignal,
): Promise<DoctorCheck> {
	const response = await new McpManagementService({
		workspaceRoot: options.workspaceRoot,
		homeDir: options.homeDir,
		env: options.env,
		createClient: options.createMcpClient ?? ((config) => new McpClient({
			config,
			cwd: options.workspaceRoot,
			sandboxProfile: workspaceSandboxProfile(options.workspaceRoot),
		})),
	}).list(signal);
	const failed = response.servers.filter((server) => server.status === "failed");
	const disabled = response.servers.filter((server) => server.status === "disabled");
	const status: DoctorStatus = !response.ok || failed.length > 0 ? "failed" : "ok";
	return check(
		"mcp",
		status,
		`configured=${response.servers.length} failed=${failed.length} disabled=${disabled.length}`,
		diagnosticClasses([
			...failed.flatMap((server) => server.failureCategory ? [server.failureCategory] : []),
			...response.issues.map(lastIssueSegment),
		]),
	);
}

async function isolated(
	name: string,
	operation: () => DoctorCheck | Promise<DoctorCheck>,
): Promise<DoctorCheck> {
	try {
		return await operation();
	} catch (error) {
		if (isAbortError(error)) throw error;
		return check(name, "failed", "diagnostic failed");
	}
}

async function isolatedMany(
	names: readonly string[],
	operation: () => readonly DoctorCheck[] | Promise<readonly DoctorCheck[]>,
): Promise<readonly DoctorCheck[]> {
	try {
		return await operation();
	} catch (error) {
		if (isAbortError(error)) throw error;
		return Object.freeze(names.map((name) => check(name, "failed", "diagnostic failed")));
	}
}

function check(
	name: string,
	status: DoctorStatus,
	message: string,
	detail?: string,
): DoctorCheck {
	return Object.freeze({ name, status, message, ...(detail ? { detail } : {}) });
}

function issueCategories(issues: readonly string[]): string | undefined {
	return diagnosticClasses(issues.map(lastIssueSegment));
}

function lastIssueSegment(issue: string): string {
	return issue.split(":").at(-1) ?? "extension_issue";
}

function diagnosticClasses(values: readonly string[]): string | undefined {
	const categories = [...new Set(values.filter((value) => /^[a-z][a-z0-9_]{0,63}$/u.test(value)))]
		.sort()
		.slice(0, 12);
	return categories.length > 0 ? `categories=${categories.join(",")}` : undefined;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
