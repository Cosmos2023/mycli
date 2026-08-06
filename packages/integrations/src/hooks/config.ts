import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { HookPoint } from "@mycli/core";
import { resolveShellProfile } from "@mycli/tools";
import type {
	ConfiguredHookMatchInput,
	ConfiguredHookMatcher,
	ConfiguredHookSpec,
	HookConfigDiagnostic,
	HookConfigDiscovery,
	HookConfigScope,
} from "./types.ts";

export interface DiscoverHookConfigOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly platform?: NodeJS.Platform;
	readonly env?: Readonly<NodeJS.ProcessEnv>;
	readonly shellPath?: string;
}

interface HookConfigFile {
	readonly path: string;
	readonly scope: HookConfigScope;
}

interface RawHookEntry {
	readonly value: unknown;
	readonly fallbackId: string;
}

const HOOK_POINTS = new Set<HookPoint>([
	"pre_tool_use",
	"post_tool_use",
	"user_prompt_submit",
	"stop",
	"pre_compact",
	"session_start",
	"session_end",
]);
const CODEX_GROUPS: Readonly<Record<string, HookPoint>> = Object.freeze({
	PreToolUse: "pre_tool_use",
	PostToolUse: "post_tool_use",
	SessionStart: "session_start",
	UserPromptSubmit: "user_prompt_submit",
	Stop: "stop",
});
const HOOK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_COMMAND_ARGUMENTS = 64;
const MAX_COMMAND_ARGUMENT_CHARS = 4_096;

class HookConfigError extends Error {
	constructor(readonly errorClass: string) {
		super(errorClass);
		this.name = "HookConfigError";
	}
}

export async function discoverHookConfig(
	options: DiscoverHookConfigOptions,
): Promise<HookConfigDiscovery> {
	const files: readonly HookConfigFile[] = [
		{ path: join(options.homeDir, ".mycli", "hooks.json"), scope: "user" },
		{ path: join(options.workspaceRoot, ".mycli", "hooks.json"), scope: "repo" },
	];
	const hooks: ConfiguredHookSpec[] = [];
	const diagnostics: HookConfigDiagnostic[] = [];

	for (const file of files) {
		const loaded = await readHookFile(file, options, diagnostics);
		hooks.push(...loaded);
	}

	return Object.freeze({
		hooks: Object.freeze(hooks),
		diagnostics: Object.freeze(diagnostics),
	});
}

export function configuredHookMatches(
	spec: ConfiguredHookSpec,
	input: ConfiguredHookMatchInput,
): boolean {
	if (spec.hookPoint === "user_prompt_submit" || spec.hookPoint === "stop") return true;
	if (spec.matcher.kind === "any") return true;
	if (spec.matcher.kind === "tool_name") return input.toolName === spec.matcher.value;
	const target = spec.hookPoint === "session_start" ? input.source : input.toolName;
	if (target === undefined) return false;
	try {
		return new RegExp(spec.matcher.value, "u").test(target);
	} catch {
		return false;
	}
}

async function readHookFile(
	file: HookConfigFile,
	options: DiscoverHookConfigOptions,
	diagnostics: HookConfigDiagnostic[],
): Promise<readonly ConfiguredHookSpec[]> {
	let raw: string;
	try {
		raw = await readFile(file.path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		diagnostics.push(issue(file, "config", "config_read_failed"));
		return [];
	}

	let payload: Readonly<Record<string, unknown>>;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) throw new HookConfigError("invalid_root");
		payload = parsed;
	} catch (error) {
		diagnostics.push(issue(
			file,
			"config",
			error instanceof HookConfigError ? error.errorClass : "invalid_json",
		));
		return [];
	}

	let entries: readonly RawHookEntry[];
	try {
		entries = rawHookEntries(payload);
	} catch (error) {
		diagnostics.push(issue(
			file,
			"config",
			error instanceof HookConfigError ? error.errorClass : "invalid_hooks",
		));
		return [];
	}

	const hooks: ConfiguredHookSpec[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		let hook: ConfiguredHookSpec;
		try {
			hook = parseHook(file, entry.value, options);
		} catch (error) {
			diagnostics.push(issue(
				file,
				safeHookId(entry.value, entry.fallbackId || `hook_${index}`),
				error instanceof HookConfigError ? error.errorClass : "invalid_hook",
			));
			continue;
		}
		if (seen.has(hook.hookId)) {
			diagnostics.push(issue(file, hook.hookId, "duplicate_hook"));
			continue;
		}
		seen.add(hook.hookId);
		hooks.push(hook);
	}
	return hooks;
}

function rawHookEntries(payload: Readonly<Record<string, unknown>>): readonly RawHookEntry[] {
	if (payload.hooks !== undefined) {
		if (!Array.isArray(payload.hooks)) throw new HookConfigError("invalid_hooks");
		return payload.hooks.map((value, index) => ({ value, fallbackId: `hook_${index}` }));
	}

	const entries: RawHookEntry[] = [];
	for (const [eventName, hookPoint] of Object.entries(CODEX_GROUPS)) {
		const rawGroups = payload[eventName];
		if (rawGroups === undefined) continue;
		if (!Array.isArray(rawGroups)) throw new HookConfigError("invalid_hooks");
		for (const [groupIndex, rawGroup] of rawGroups.entries()) {
			if (!isRecord(rawGroup) || !Array.isArray(rawGroup.hooks)) {
				entries.push({ value: rawGroup, fallbackId: `${eventName}-${groupIndex}` });
				continue;
			}
			for (const [hookIndex, rawHook] of rawGroup.hooks.entries()) {
				if (isRecord(rawHook) && rawHook.type !== undefined && rawHook.type !== "command") {
					continue;
				}
				const fallbackId = `${eventName}-${groupIndex}-${hookIndex}`;
				entries.push({
					fallbackId,
					value: isRecord(rawHook)
						? {
							...rawHook,
							id: nonEmptyString(rawHook.id) ?? fallbackId,
							hook_point: hookPoint,
							matcher: rawGroup.matcher,
							timeout_seconds: rawHook.timeout ?? rawHook.timeoutSec,
							working_directory: rawHook.working_directory ?? "workspace",
							env_policy: rawHook.env_policy ?? "minimal",
						}
						: rawHook,
				});
			}
		}
	}
	return entries;
}

function parseHook(
	file: HookConfigFile,
	value: unknown,
	options: DiscoverHookConfigOptions,
): ConfiguredHookSpec {
	if (!isRecord(value)) throw new HookConfigError("invalid_hook");
	const hookId = nonEmptyString(value.id);
	if (!hookId || !HOOK_ID.test(hookId)) throw new HookConfigError("invalid_hook_id");
	const hookPoint = nonEmptyString(value.hook_point);
	if (!hookPoint || !HOOK_POINTS.has(hookPoint as HookPoint)) {
		throw new HookConfigError("invalid_hook_point");
	}
	const command = commandValue(value.command, options);
	const timeoutMs = timeoutValue(value.timeout_seconds);
	const workingDirectory = enumValue(
		value.working_directory,
		["workspace", "config"] as const,
		"workspace",
		"invalid_working_directory",
	);
	const envPolicy = enumValue(
		value.env_policy,
		["minimal", "inherit_safe"] as const,
		"minimal",
		"invalid_env_policy",
	);
	const matcher = matcherValue(value.matcher);
	const enabled = booleanValue(value.enabled, true);

	return Object.freeze({
		hookId,
		name: `configured:${file.scope}:${hookId}`,
		hookPoint: hookPoint as HookPoint,
		command: command.argv,
		...(command.shellKind ? { shellKind: command.shellKind } : {}),
		enabled,
		timeoutMs,
		workingDirectory,
		envPolicy,
		matcher,
		scope: file.scope,
		configPath: file.path,
	});
}

function commandValue(
	value: unknown,
	options: DiscoverHookConfigOptions,
): { readonly argv: readonly string[]; readonly shellKind?: ConfiguredHookSpec["shellKind"] } {
	if (typeof value === "string" && value.trim()) {
		if (value.includes("\0")) throw new HookConfigError("invalid_command");
		const profile = resolveShellProfile({
			...(options.platform ? { platform: options.platform } : {}),
			...(options.env ? { env: options.env } : {}),
			...(options.shellPath ? { shellPath: options.shellPath } : {}),
		});
		return {
			argv: Object.freeze([profile.executable, ...profile.execArgv(value.trim())]),
			shellKind: profile.kind,
		};
	}
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMMAND_ARGUMENTS) {
		throw new HookConfigError("invalid_command");
	}
	if (value.some((item) => (
		typeof item !== "string"
		|| !item.trim()
		|| item.includes("\0")
		|| item.length > MAX_COMMAND_ARGUMENT_CHARS
	))) {
		throw new HookConfigError("invalid_command");
	}
	return { argv: Object.freeze(value.map((item) => (item as string).trim())) };
}

function timeoutValue(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new HookConfigError("invalid_timeout");
	}
	const timeoutMs = value * 1_000;
	if (timeoutMs > MAX_TIMEOUT_MS) throw new HookConfigError("invalid_timeout");
	return Math.round(timeoutMs);
}

function matcherValue(value: unknown): ConfiguredHookMatcher {
	if (value === undefined || value === null) return Object.freeze({ kind: "any" });
	if (typeof value === "string") return patternMatcher(value);
	if (!isRecord(value)) throw new HookConfigError("invalid_matcher");
	if (value.tool_name !== undefined) {
		const toolName = nonEmptyString(value.tool_name);
		if (!toolName || toolName.length > 128) throw new HookConfigError("invalid_matcher");
		return Object.freeze({ kind: "tool_name", value: toolName });
	}
	if (value.pattern !== undefined) {
		if (typeof value.pattern !== "string") throw new HookConfigError("invalid_matcher");
		return patternMatcher(value.pattern);
	}
	return Object.freeze({ kind: "any" });
}

function patternMatcher(value: string): ConfiguredHookMatcher {
	const pattern = value.trim();
	if (!pattern || pattern === "*") return Object.freeze({ kind: "any" });
	if (pattern.length > 512) throw new HookConfigError("invalid_matcher");
	try {
		new RegExp(pattern, "u");
	} catch {
		throw new HookConfigError("invalid_matcher");
	}
	return Object.freeze({ kind: "pattern", value: pattern });
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new HookConfigError("invalid_enabled");
	return value;
}

function enumValue<const Value extends string>(
	value: unknown,
	allowed: readonly Value[],
	fallback: Value,
	errorClass: string,
): Value {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "string" || !allowed.includes(value as Value)) {
		throw new HookConfigError(errorClass);
	}
	return value as Value;
}

function issue(
	file: HookConfigFile,
	hookId: string,
	errorClass: string,
): HookConfigDiagnostic {
	return Object.freeze({
		scope: file.scope,
		fileLabel: basename(file.path).slice(0, 64),
		hookId: HOOK_ID.test(hookId) ? hookId : "hook",
		errorClass: errorClass.slice(0, 64),
	});
}

function safeHookId(value: unknown, fallback: string): string {
	if (!isRecord(value)) return fallback;
	const hookId = nonEmptyString(value.id);
	return hookId && HOOK_ID.test(hookId) ? hookId : fallback;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
