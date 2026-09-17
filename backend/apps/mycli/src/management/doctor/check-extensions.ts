import { join } from "node:path";
import {
	builtinSkillRoot as defaultBuiltinSkillRoot,
	discoverConfiguredMcpServers,
	discoverPlugins,
	HookManagementService,
	SkillRegistry,
} from "@mycli/integrations";
import type { DoctorCheck, DoctorStatus } from "./types.ts";

export interface ExtensionDoctorOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly includeRepository?: boolean;
	readonly builtinSkillRoot?: string;
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
	signal.throwIfAborted();
	const discovery = await discoverPlugins(options);
	signal.throwIfAborted();
	const migrations = discovery.selected.filter((plugin) => plugin.kind === "migration_required");
	const invalid = discovery.selected.filter((plugin) => plugin.kind === "invalid");
	const issues = [
		...discovery.diagnostics.map((issue) => issue.errorClass),
		...discovery.selected.flatMap((plugin) => plugin.kind === "bundle" ? plugin.manifest.issues : []),
		...discovery.plugins.filter((plugin) => plugin.enabled
			&& plugin.manifest.requires_env.some((key) => !options.env[key])).map(() => "missing_required_env"),
	];
	const enabled = discovery.selected.filter((plugin) => plugin.enabled).length;
	return Object.freeze([
		check(
			"plugins",
			issues.length > 0 ? "failed" : "ok",
			`configured=${discovery.selected.length} enabled=${enabled} invalid=${invalid.length} runtime=not_probed`,
			diagnosticClasses(issues),
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
		...(options.includeRepository === false ? {} : {
			sharedRepoRoot: join(options.workspaceRoot, ".agents", "skills"),
			repoRoot: join(options.workspaceRoot, ".mycli", "skills"),
		}),
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
	signal.throwIfAborted();
	const config = await discoverConfiguredMcpServers(options);
	signal.throwIfAborted();
	const disabled = config.servers.filter((server) => !server.enabled).length;
	const issues = [...config.diagnostics, ...config.pluginIssues].map((issue) => issue.errorClass);
	return check(
		"mcp",
		issues.length > 0 ? "failed" : "ok",
		`configured=${config.servers.length} disabled=${disabled} invalid=${issues.length} runtime=not_probed`,
		diagnosticClasses(issues),
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
