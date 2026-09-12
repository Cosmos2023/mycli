import type { ManagementCommand, ManagementResponse } from "./types.ts";
import type {
	ConfigManagementResponse,
	ConfigSettingRow,
	ConfigSettingValue,
} from "./config.ts";
import { redactDoctorText } from "./doctor/redaction.ts";
import type { SandboxManagementResponse } from "./sandbox.ts";
import type { SessionManagementResponse } from "./session.ts";
import type { SessionSummary } from "../node-runtime/session-service.ts";
import type { UpdateManagementResponse } from "./update.ts";
import type { AuthManagementResponse } from "./auth.ts";

export function renderManagementResponse(
	command: ManagementCommand,
	response: ManagementResponse,
): string {
	if (command.json) return `${JSON.stringify(response)}\n`;
	if (command.kind === "doctor") return renderDoctor(response, command.verbose);
	if (command.kind === "sandbox") {
		return renderSandbox(response as SandboxManagementResponse);
	}
	if (command.kind === "config") {
		return renderConfig(response as ConfigManagementResponse);
	}
	if (command.kind === "update") return renderUpdate(response as UpdateManagementResponse);
	if (command.kind === "session") {
		return renderSession(response as SessionManagementResponse);
	}
	if (command.kind === "login" || command.kind === "logout") {
		return renderAuth(response as AuthManagementResponse);
	}
	const lines = [response.message ?? `mycli ${command.kind} ${response.ok ? "complete" : "failed"}`];
	for (const row of responseRows(command, response)) lines.push(row);
	for (const issue of response.issues ?? []) lines.push(`issue=${issue}`);
	return `${lines.join("\n")}\n`;
}

function renderAuth(response: AuthManagementResponse): string {
	const lines = [
		`mycli ${response.action}`,
		`provider=${response.provider}`,
		`auth_ref=${response.authRef}`,
		`configured=${response.configured}`,
		`source=${response.source}`,
		`stored=${response.stored}`,
	];
	if (response.removed !== undefined) lines.push(`removed=${response.removed}`);
	if (response.message) lines.push(response.message);
	for (const issue of response.issues ?? []) lines.push(`issue=${issue}`);
	return `${lines.join("\n")}\n`;
}

function renderUpdate(response: UpdateManagementResponse): string {
	const status = response.status;
	const lines = [
		`mycli update ${response.action}`,
		`status=${status.availability}`,
		`current=${status.currentVersion}`,
		`latest=${status.latestVersion ?? "unknown"}`,
		`cache=${status.cacheState}`,
		`startup_check=${status.checkOnStartup ? "enabled" : "disabled"}`,
		`install_method=${status.install.method}`,
		`install_command=${status.install.command}`,
	];
	if (status.install.fallback) lines.push("install_command_is_fallback=true");
	if (response.refreshOutcome) lines.push(`refresh=${response.refreshOutcome}`);
	if (response.dismissedVersion) lines.push(`dismissed=${response.dismissedVersion}`);
	if (!response.ok) {
		lines.push(response.message ?? "update command failed");
		for (const issue of response.issues ?? []) lines.push(`issue=${issue}`);
	}
	return `${lines.join("\n")}\n`;
}

function renderSession(response: SessionManagementResponse): string {
	if (response.exportedSession) return `${JSON.stringify(response.exportedSession, null, 2)}\n`;
	const lines = [`mycli session ${response.action}`];
	for (const session of response.sessions ?? []) lines.push(renderSessionSummary(session));
	if (response.session) lines.push(renderSessionSummary(response.session));
	if (!response.ok || (!response.session && (response.sessions?.length ?? 0) === 0)) {
		lines.push(response.message ?? (response.ok ? "no sessions found" : "session command failed"));
	}
	for (const issue of response.issues ?? []) lines.push(`issue=${issue}`);
	return `${lines.join("\n")}\n`;
}

function renderSessionSummary(session: SessionSummary): string {
	return [
		"session",
		`id=${scalar(session.id)}`,
		...(session.title ? [`title=${JSON.stringify(session.title)}`] : []),
		`cwd=${JSON.stringify(session.cwd)}`,
		`last_active=${session.lastActiveAt}`,
		`model=${scalar(session.model)}`,
		`effort=${session.reasoningEffort}`,
		`mode=${session.collaborationMode}`,
		`permission=${session.permissionProfile}`,
		`status=${session.lifecycleStatus}`,
		`lock=${session.leaseState}`,
		...(session.parentId ? [`parent=${scalar(session.parentId)}`] : []),
	].join(" ");
}

function renderSandbox(response: SandboxManagementResponse): string {
	const lines = [
		`mycli sandbox ${response.action}`,
	];
	if (response.result && response.preview) {
		lines.push(
			`result=${response.result.status}`,
			`result_code=${response.result.code}`,
			`confirmation_required=${response.preview.confirmationRequired}`,
			`privilege=${response.preview.privilege}`,
			`effects=${response.preview.effects.join(",") || "none"}`,
		);
		if (response.preview.confirmationFlag) {
			lines.push(`confirmation_flag=${response.preview.confirmationFlag}`);
		}
	}
	lines.push(
		`state=${response.readiness.state}`,
		`code=${response.readiness.code}`,
		`platform=${response.readiness.platform}`,
		`isolation=${response.readiness.isolation}`,
	);
	if (response.readiness.helperVersion !== undefined) {
		lines.push(`helper_version=${response.readiness.helperVersion}`);
	}
	if (response.readiness.helperCompatible !== undefined) {
		lines.push(`helper_compatible=${response.readiness.helperCompatible}`);
	}
	if (response.readiness.setupComplete !== undefined) {
		lines.push(`setup_complete=${response.readiness.setupComplete}`);
	}
	if (response.readiness.sandboxReady !== undefined) {
		lines.push(`sandbox_ready=${response.readiness.sandboxReady}`);
	}
	if (response.remediation) lines.push(`remediation=${response.remediation}`);
	return `${lines.join("\n")}\n`;
}

function renderConfig(response: ConfigManagementResponse): string {
	const lines = [`mycli config ${response.action}`];
	if (response.action === "show" && response.ok) {
		lines.push(`workspace_trust=${response.workspaceTrust}`);
		lines.push(`api_key=${response.credentials.apiKey}`);
		for (const layer of response.layers) {
			lines.push([
				"layer",
				`id=${layer.id}`,
				`scope=${layer.scope}`,
				`enabled=${layer.enabled}`,
				...(layer.disabledReason ? [`reason=${layer.disabledReason}`] : []),
			].join(" "));
		}
		for (const setting of response.settings) lines.push(renderConfigSetting(setting));
	} else if (response.action === "get" && response.ok) {
		lines.push(renderConfigSetting(response.setting));
	} else if (response.action === "path" && response.ok) {
		lines.push(`scope=${response.scope}`);
		lines.push(`path=${JSON.stringify(response.path)}`);
		lines.push(`writable=${response.writable}`);
	} else if ((response.action === "set" || response.action === "unset") && response.ok) {
		lines.push(`key=${response.key}`);
		lines.push(`changed=${response.changed}`);
		lines.push(`effective_source=${response.effectiveSource}`);
		lines.push(`overridden=${response.overridden.join(",") || "none"}`);
	} else if (response.action === "migrate" && response.ok) {
		lines.push(`operation=${response.operation}`);
		if (response.needed !== undefined) lines.push(`needed=${response.needed}`);
		if (response.applied !== undefined) lines.push(`applied=${response.applied}`);
		if (response.restored !== undefined) lines.push(`restored=${response.restored}`);
		if (response.expectedVersion) lines.push(`expected_version=${response.expectedVersion}`);
		lines.push(`current_version=${response.currentVersion}`);
		if (response.legacyVersion) lines.push(`legacy_version=${response.legacyVersion}`);
		if (response.resultingVersion) lines.push(`resulting_version=${response.resultingVersion}`);
		if (response.backupId) lines.push(`backup_id=${response.backupId}`);
		for (const change of response.changes ?? []) {
			lines.push([
				"change",
				`kind=${change.kind}`,
				`key=${change.key}`,
				`source=${change.source}`,
				`effective_source=${change.effectiveSource}`,
				`overridden=${change.overridden.join(",") || "none"}`,
			].join(" "));
		}
		if (response.truncated) lines.push("changes_truncated=true");
	} else {
		lines.push(response.message ?? (response.ok ? "configuration valid" : "configuration invalid"));
	}
	for (const diagnostic of response.diagnostics ?? []) {
		const context = [
			diagnostic.layer ? `layer=${diagnostic.layer}` : undefined,
			diagnostic.keyPath ? `key=${diagnostic.keyPath}` : undefined,
			diagnostic.line ? `line=${diagnostic.line}` : undefined,
			diagnostic.column ? `column=${diagnostic.column}` : undefined,
		].filter((value): value is string => value !== undefined).join(" ");
		lines.push(
			`[${diagnostic.severity === "warning" ? "WARN" : "FAIL"}] ${diagnostic.code}`
			+ `${context ? ` ${context}` : ""}: ${diagnostic.message}`,
		);
		if (diagnostic.remediation) lines.push(`  remedy: ${diagnostic.remediation}`);
	}
	return `${lines.join("\n")}\n`;
}

function renderConfigSetting(setting: ConfigSettingRow): string {
	return [
		"setting",
		`${setting.key}=${configValue(setting.value)}`,
		`source=${setting.source}`,
		`overridden=${setting.overridden.join(",") || "none"}`,
		...(setting.truncated ? ["truncated=true"] : []),
	].join(" ");
}

function configValue(value: ConfigSettingValue): string {
	if (value === null) return "unset";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function renderDoctor(response: ManagementResponse, verbose: boolean): string {
	const checks = Array.isArray(Reflect.get(response, "checks"))
		? (Reflect.get(response, "checks") as readonly unknown[]).flatMap((value) => {
			const row = record(value);
			if (!row) return [];
			const name = typeof row.name === "string" ? row.name : "diagnostic";
			const status: "ok" | "warning" | "failed" = row.status === "ok"
				|| row.status === "warning"
				|| row.status === "failed"
				? row.status
				: "failed";
			const message = typeof row.summary === "string"
				? row.summary
				: typeof row.message === "string" ? row.message : "diagnostic failed";
			const details = Array.isArray(row.details)
				? row.details.filter((value): value is string => typeof value === "string").slice(0, 8)
				: typeof row.detail === "string" ? [row.detail] : [];
			const remediation = typeof row.remediation === "string" ? row.remediation : undefined;
			const durationMs = typeof row.durationMs === "number" ? row.durationMs : 0;
			return [{ name, status, message, details, remediation, durationMs }];
		})
		: [];
	const marker = { ok: "[OK]", warning: "[WARN]", failed: "[FAIL]" } as const;
	if (checks.length === 0 && response.message && response.message !== "mycli doctor") {
		return `${redactDoctorText(response.message)}\n`;
	}
	const lines = ["mycli doctor"];
	for (const check of checks) {
		lines.push(`${marker[check.status]} ${redactDoctorText(check.name)}: ${redactDoctorText(check.message)}`);
		if (verbose) {
			for (const detail of check.details) lines.push(`  detail: ${redactDoctorText(detail)}`);
			if (check.remediation) lines.push(`  remedy: ${redactDoctorText(check.remediation)}`);
			lines.push(`  duration_ms: ${Math.max(0, Math.round(check.durationMs))}`);
		}
	}
	lines.push(
		`Summary: ${countValue(response, "okCount")} ok, `
		+ `${countValue(response, "warningCount")} warning, `
		+ `${countValue(response, "failedCount")} failed`,
	);
	const repair = record(Reflect.get(response, "repair"));
	if (repair) lines.push(...renderDoctorRepair(repair, verbose));
	const bundle = record(Reflect.get(response, "bundle"));
	if (bundle) {
		const location = typeof bundle.location === "string"
			? redactDoctorText(bundle.location).slice(0, 128)
			: ".mycli/support/diagnostic-support.json";
		lines.push(
			`Support bundle: ~/${location}`,
			`  bytes=${countRecordValue(bundle, "bytes")}`,
			`  sha256=${safeIdentifier(bundle.sha256, "unavailable", 64)}`,
		);
	}
	for (const issue of response.issues ?? []) lines.push(`issue=${redactDoctorText(issue)}`);
	return `${lines.join("\n")}\n`;
}

function renderDoctorRepair(
	repair: Readonly<Record<string, unknown>>,
	verbose: boolean,
): readonly string[] {
	const status = safeIdentifier(repair.status, "failed", 64);
	const code = safeIdentifier(repair.code, "repair_failed", 64);
	const plan = record(repair.plan);
	const planId = safeIdentifier(plan?.planId, "unavailable", 96);
	const actions = Array.isArray(plan?.actions)
		? plan.actions.flatMap((value) => record(value) ? [record(value)!] : [])
		: [];
	const lines = [
		`Repair: ${status}`,
		`  code=${code}`,
		`  plan_id=${planId}`,
		`  actions=${actions.length}`,
	];
	for (const action of actions) {
		const changes = Array.isArray(action.changes) ? action.changes.length : 0;
		lines.push(
			`  action=${safeIdentifier(action.id, "repair", 64)} changes=${changes}`,
		);
		if (!verbose) continue;
		for (const effect of Array.isArray(action.effects) ? action.effects.slice(0, 8) : []) {
			if (typeof effect === "string") lines.push(`    effect: ${redactDoctorText(effect)}`);
		}
	}
	for (const value of Array.isArray(repair.results) ? repair.results : []) {
		const result = record(value);
		if (!result) continue;
		lines.push([
			"  result",
			`id=${safeIdentifier(result.id, "repair", 64)}`,
			`status=${safeIdentifier(result.status, "failed", 64)}`,
			`code=${safeIdentifier(result.code, "repair_failed", 64)}`,
			`changed=${result.changed === true}`,
		].join(" "));
	}
	if (status === "preview" && actions.length > 0 && planId !== "unavailable") {
		lines.push(`  apply=mycli doctor --fix --confirm ${planId}`);
	}
	return lines;
}

function countValue(response: ManagementResponse, key: string): number {
	const value = Reflect.get(response, key);
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function countRecordValue(row: Readonly<Record<string, unknown>>, key: string): number {
	const value = row[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeIdentifier(value: unknown, fallback: string, limit: number): string {
	return typeof value === "string" && /^[A-Za-z0-9:_-]+$/u.test(value)
		? value.slice(0, limit)
		: fallback;
}

function responseRows(
	command: ManagementCommand,
	response: ManagementResponse,
): readonly string[] {
	if (command.kind === "hooks") {
		return rows(response, "hooks").map((row) => fields("hook", row, [
			"identity", "hookPoint", "enabled", "allowlistStatus", "allowlistReason",
		]));
	}
	if (command.kind === "plugins") {
		const result = record(Reflect.get(response, "commandResult"));
		return [
			...rows(response, "plugins").map((row) => fields("plugin", row, [
				"pluginId", "source", "enabled", "status", "format", "version", "skillCount", "tools", "hooks", "commands",
			])),
			...rows(response, "marketplaces").map((row) => fields("marketplace", row, ["name", "source"])),
			...(result ? [fields("command", result, ["ok", "summary", "error"])] : []),
		];
	}
	if (command.kind === "mcp") {
		return [
			...rows(response, "servers").map((row) => fields("mcp", row, [
				"serverId", "selector", "pluginId", "pluginServerName", "source", "transport", "enabled", "required", "status", "authStatus", "toolCount", "startupTimeoutMs", "toolTimeoutMs", "defaultToolsApprovalMode",
			])),
			...rows(response, "approvals").map((row) => fields("approval", row, ["id"])),
		];
	}
	return [];
}

function rows(response: ManagementResponse, key: string): readonly Readonly<Record<string, unknown>>[] {
	const value = Reflect.get(response, key);
	return Array.isArray(value) ? value.flatMap((row) => record(row) ? [record(row)!] : []) : [];
}

function fields(
	prefix: string,
	row: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): string {
	const values = keys.flatMap((key) => row[key] === undefined ? [] : [`${key}=${scalar(row[key])}`]);
	return `${prefix} ${values.join(" ")}`.trimEnd();
}

function scalar(value: unknown): string {
	if (Array.isArray(value)) return value.map((item) => String(item)).join(",") || "none";
	return String(value).replace(/[\r\n]+/gu, " ").slice(0, 512);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: undefined;
}
