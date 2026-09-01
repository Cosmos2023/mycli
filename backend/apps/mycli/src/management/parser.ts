import { CONFIG_PATH_SCOPES, type ConfigPathScope } from "@mycli/config/paths";
import type {
	AuthManagementCommand,
	CliMode,
	ConfigManagementCommand,
	DoctorManagementCommand,
	HooksManagementCommand,
	ManagementCommand,
	McpManagementCommand,
	PluginsManagementCommand,
	SandboxManagementCommand,
	SessionManagementCommand,
	SetupManagementCommand,
} from "./types.ts";

export const MANAGEMENT_COMMAND_NAMES = Object.freeze([
	"setup",
	"login",
	"logout",
	"config",
	"doctor",
	"update",
	"sandbox",
	"hooks",
	"plugins",
	"mcp",
	"session",
] as const);

const MANAGEMENT_COMMANDS: ReadonlySet<string> = new Set(MANAGEMENT_COMMAND_NAMES);
const DOCTOR_PLAN_ID = /^doctor-plan-v1-[a-f0-9]{64}$/u;

export function parseCliMode(argv: readonly string[]): CliMode {
	const root = argv[0];
	if (root === "session" && argv[1] === "resume") {
		if (argv.length !== 3) throw usage("session resume <session_id>");
		return Object.freeze({
			kind: "interactive",
			runtimeArgs: Object.freeze(["--session", nonEmpty(argv[2])]),
		});
	}
	if (!root || !MANAGEMENT_COMMANDS.has(root)) {
		validateInteractiveArguments(argv);
		return Object.freeze({ kind: "interactive", runtimeArgs: Object.freeze([...argv]) });
	}
	return Object.freeze({ kind: "management", command: parseManagementCommand(root, argv.slice(1)) });
}

function parseManagementCommand(root: string, rawArgs: readonly string[]): ManagementCommand {
	if (root === "setup") {
		return parseSetup(rawArgs);
	}
	const { args, json } = extractFlag(rawArgs, "--json");
	if (root === "login" || root === "logout") return parseAuth(root, args, json);
	if (root === "doctor") {
		return parseDoctor(args, json);
	}
	if (root === "sandbox") {
		return parseSandbox(args, json);
	}
	if (root === "update") return parseUpdate(args, json);
	if (root === "config") return parseConfig(args, json);
	if (root === "hooks") return parseHooks(args, json);
	if (root === "plugins") return parsePlugins(args, json);
	if (root === "mcp") return parseMcp(args, json);
	return parseSession(args, json);
}

function parseDoctor(args: readonly string[], json: boolean): DoctorManagementCommand {
	const verbose = extractFlag(args, "--verbose");
	const fix = extractFlag(verbose.args, "--fix");
	const support = extractFlag(fix.args, "--support-bundle");
	const confirmation = extractDoctorConfirmation(support.args);
	if (confirmation.args.length > 0 || (fix.json && support.json)
		|| (!fix.json && confirmation.value !== undefined)
		|| (confirmation.value !== undefined && !DOCTOR_PLAN_ID.test(confirmation.value))) {
		throw doctorUsage();
	}
	if (support.json) {
		return Object.freeze({
			kind: "doctor",
			operation: "support",
			json,
			verbose: verbose.json,
		});
	}
	if (fix.json) {
		return Object.freeze({
			kind: "doctor",
			operation: "fix",
			...(confirmation.value ? { expectedPlanId: confirmation.value } : {}),
			json,
			verbose: verbose.json,
		});
	}
	return Object.freeze({
		kind: "doctor",
		operation: "check",
		json,
		verbose: verbose.json,
	});
}

function extractDoctorConfirmation(
	args: readonly string[],
): { readonly args: readonly string[]; readonly value?: string } {
	const remaining: string[] = [];
	let value: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument !== "--confirm") {
			remaining.push(argument!);
			continue;
		}
		if (value !== undefined || !args[index + 1] || args[index + 1]?.startsWith("--")) {
			throw doctorUsage();
		}
		value = nonEmpty(args[index + 1]);
		index += 1;
	}
	return Object.freeze({
		args: Object.freeze(remaining),
		...(value ? { value } : {}),
	});
}

function parseSandbox(args: readonly string[], json: boolean): SandboxManagementCommand {
	const action = args[0];
	if (action === "status" && args.length === 1) {
		return Object.freeze({ kind: "sandbox", action, json });
	}
	if (action === "setup" || action === "reset") {
		const confirmation = extractFlag(args.slice(1), "--confirm");
		if (confirmation.args.length === 0) {
			return Object.freeze({
				kind: "sandbox",
				action,
				confirmed: confirmation.json,
				json,
			});
		}
	}
	throw usage("sandbox status|setup|reset [--confirm] [--json]");
}

function parseSetup(rawArgs: readonly string[]): SetupManagementCommand {
	if (rawArgs.length === 0) return Object.freeze({ kind: "setup", json: false });
	if (rawArgs.some((value) => value === "--api-key" || value.startsWith("--api-key="))) {
		throw new Error(
			"invalid_arguments: --api-key is not supported; use --with-api-key and pipe the key to stdin",
		);
	}
	const jsonFlag = extractFlag(rawArgs, "--json");
	const nonInteractiveFlag = extractFlag(jsonFlag.args, "--non-interactive");
	const withApiKeyFlag = extractFlag(nonInteractiveFlag.args, "--with-api-key");
	if (!nonInteractiveFlag.json || !withApiKeyFlag.json) throw setupUsage();
	let provider: string | undefined;
	let model: string | undefined;
	let apiBaseUrl: string | undefined;
	for (let index = 0; index < withApiKeyFlag.args.length; index += 1) {
		const option = withApiKeyFlag.args[index];
		const value = withApiKeyFlag.args[index + 1];
		if (!value || value.startsWith("--")) throw setupUsage();
		if (option === "--provider" && provider === undefined) provider = nonEmpty(value);
		else if (option === "--model" && model === undefined) model = nonEmpty(value);
		else if (option === "--base-url" && apiBaseUrl === undefined) apiBaseUrl = nonEmpty(value);
		else throw setupUsage();
		index += 1;
	}
	if (!provider) throw setupUsage();
	return Object.freeze({
		kind: "setup",
		json: jsonFlag.json,
		nonInteractive: true,
		provider,
		...(model ? { model } : {}),
		...(apiBaseUrl ? { apiBaseUrl } : {}),
		withApiKey: true,
	});
}

function parseAuth(
	root: "login" | "logout",
	args: readonly string[],
	json: boolean,
): AuthManagementCommand {
	if (args.some((value) => value === "--api-key" || value.startsWith("--api-key="))) {
		throw new Error(
			"invalid_arguments: --api-key is not supported; pipe the key to mycli login --with-api-key",
		);
	}
	let action: "status" | "api_key" | "logout";
	let remaining: readonly string[];
	if (root === "logout") {
		action = "logout";
		remaining = args;
	} else if (args[0] === "status") {
		action = "status";
		remaining = args.slice(1);
	} else {
		const withApiKey = extractFlag(args, "--with-api-key");
		if (!withApiKey.json) throw authUsage();
		action = "api_key";
		remaining = withApiKey.args;
	}
	let provider: string | undefined;
	let authRef: string | undefined;
	for (let index = 0; index < remaining.length; index += 1) {
		const option = remaining[index];
		const value = remaining[index + 1];
		if ((option !== "--provider" && option !== "--auth-ref") || !value || value.startsWith("--")) {
			throw authUsage();
		}
		if (option === "--provider") {
			if (provider !== undefined) throw authUsage();
			provider = nonEmpty(value);
		} else {
			if (authRef !== undefined) throw authUsage();
			authRef = nonEmpty(value);
		}
		index += 1;
	}
	return Object.freeze({
		kind: root,
		action,
		...(provider ? { provider } : {}),
		...(authRef ? { authRef } : {}),
		json,
	} as AuthManagementCommand);
}

function parseUpdate(args: readonly string[], json: boolean): ManagementCommand {
	if (args.length === 0 || (args.length === 1 && args[0] === "status")) {
		return Object.freeze({ kind: "update", action: "status", json });
	}
	if (args.length === 1 && args[0] === "check") {
		return Object.freeze({ kind: "update", action: "check", json });
	}
	if (args.length === 2 && args[0] === "dismiss") {
		return Object.freeze({ kind: "update", action: "dismiss", version: nonEmpty(args[1]), json });
	}
	throw usage("update [status|check|dismiss <version>] [--json]");
}

function parseSession(args: readonly string[], json: boolean): SessionManagementCommand {
	const action = args[0];
	if (action === "list") return parseSessionList(args.slice(1), json);
	if (action === "fork" && (args.length === 2 || args.length === 3)) {
		return Object.freeze({
			kind: "session",
			action,
			sessionId: nonEmpty(args[1]),
			...(args[2] ? { targetSessionId: nonEmpty(args[2]) } : {}),
			json,
		});
	}
	if (action === "rename" && args.length === 3) {
		return Object.freeze({
			kind: "session",
			action,
			sessionId: nonEmpty(args[1]),
			title: nonEmpty(args[2]),
			json,
		});
	}
	if ((action === "archive" || action === "unarchive" || action === "export")
		&& args.length === 2) {
		return Object.freeze({
			kind: "session",
			action,
			sessionId: nonEmpty(args[1]),
			json,
		});
	}
	if (action === "delete") {
		const force = args.filter((value) => value === "--force").length;
		const remaining = args.slice(1).filter((value) => value !== "--force");
		if (force > 1 || remaining.length !== 1) throw sessionUsage();
		return Object.freeze({
			kind: "session",
			action,
			sessionId: nonEmpty(remaining[0]),
			force: force === 1,
			json,
		});
	}
	throw sessionUsage();
}

function parseSessionList(args: readonly string[], json: boolean): SessionManagementCommand {
	let all = false;
	let last = false;
	let workspaceRoot: string | undefined;
	let search: string | undefined;
	let model: string | undefined;
	let collaborationMode: "default" | "plan" | undefined;
	let permissionProfile: "read-only" | "workspace" | "full-access" | undefined;
	let status: "active" | "archived" | "deleted" | "waiting_approval"
		| "waiting_clarification" | "interrupted" | undefined;
	let limit: number | undefined;
	const option = (name: string, value: string | undefined): string => {
		if (!value || value.startsWith("--")) throw sessionUsage();
		return nonEmpty(value);
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--all") {
			if (all) throw sessionUsage();
			all = true;
			continue;
		}
		if (argument === "--last") {
			if (last) throw sessionUsage();
			last = true;
			continue;
		}
		const value = option(argument ?? "", args[index + 1]);
		index += 1;
		if (argument === "--workspace") workspaceRoot = singleOption(workspaceRoot, value);
		else if (argument === "--search") search = singleOption(search, value);
		else if (argument === "--model") model = singleOption(model, value);
		else if (argument === "--mode" && (value === "default" || value === "plan")) {
			collaborationMode = singleOption(collaborationMode, value);
		} else if (argument === "--permission"
			&& (value === "read-only" || value === "workspace" || value === "full-access")) {
			permissionProfile = singleOption(permissionProfile, value);
		} else if (argument === "--status" && isSessionStatus(value)) {
			status = singleOption(status, value);
		} else if (argument === "--limit") {
			if (limit !== undefined || !/^\d+$/u.test(value)) throw sessionUsage();
			limit = Number(value);
		} else if (!["--workspace", "--search", "--model"].includes(argument ?? "")) {
			throw sessionUsage();
		}
	}
	return Object.freeze({
		kind: "session",
		action: "list",
		json,
		all,
		last,
		...(workspaceRoot ? { workspaceRoot } : {}),
		...(search ? { search } : {}),
		...(model ? { model } : {}),
		...(collaborationMode ? { collaborationMode } : {}),
		...(permissionProfile ? { permissionProfile } : {}),
		...(status ? { status } : {}),
		...(limit === undefined ? {} : { limit }),
	});
}

function singleOption<Value>(current: Value | undefined, value: Value): Value {
	if (current !== undefined) throw sessionUsage();
	return value;
}

function isSessionStatus(value: string): value is NonNullable<Extract<
	SessionManagementCommand,
	{ readonly action: "list" }
>["status"]> {
	return [
		"active",
		"archived",
		"deleted",
		"waiting_approval",
		"waiting_clarification",
		"interrupted",
	].includes(value);
}

function parseConfig(args: readonly string[], json: boolean): ConfigManagementCommand {
	const action = args[0];
	if (action === "validate") {
		const strict = extractFlag(args.slice(1), "--strict");
		if (strict.args.length !== 0) throw configUsage();
		return Object.freeze({
			kind: "config",
			action,
			...(strict.json ? { strict: true } : {}),
			json,
		});
	}
	if (action === "show" && args.length === 1) {
		return Object.freeze({ kind: "config", action, json });
	}
	if (action === "path") {
		return parseConfigPath(args.slice(1), json);
	}
	if ((action === "get" || action === "unset") && args.length === 2) {
		return Object.freeze({ kind: "config", action, key: nonEmpty(args[1]), json });
	}
	if (action === "set" && args.length === 3) {
		return Object.freeze({
			kind: "config",
			action,
			key: nonEmpty(args[1]),
			value: args[2]!,
			json,
		});
	}
	if (action === "migrate") {
		if (args.length === 2 && args[1] === "--dry-run") {
			return Object.freeze({ kind: "config", action, operation: "preview", json });
		}
		if (args.length === 4 && args[1] === "--apply" && args[2] === "--expected-version") {
			return Object.freeze({
				kind: "config",
				action,
				operation: "apply",
				expectedVersion: nonEmpty(args[3]),
				json,
			});
		}
		if (args.length === 3 && args[1] === "--rollback") {
			return Object.freeze({
				kind: "config",
				action,
				operation: "rollback",
				backupId: nonEmpty(args[2]),
				json,
			});
		}
	}
	throw configUsage();
}

function parseConfigPath(args: readonly string[], json: boolean): ConfigManagementCommand {
	let profile: string | undefined;
	const positional: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument !== "--profile") {
			positional.push(argument!);
			continue;
		}
		if (profile !== undefined || !args[index + 1]) throw configUsage();
		profile = nonEmpty(args[index + 1]);
		index += 1;
	}
	if (positional.length > 1) throw configUsage();
	const scopeValue = positional[0] ?? "user";
	if (!CONFIG_PATH_SCOPES.includes(scopeValue as ConfigPathScope)) throw configUsage();
	const scope = scopeValue as ConfigPathScope;
	if ((scope === "profile") !== (profile !== undefined)) throw configUsage();
	return Object.freeze({
		kind: "config",
		action: "path",
		scope,
		...(profile ? { profile } : {}),
		json,
	});
}

function parseHooks(args: readonly string[], json: boolean): HooksManagementCommand {
	const action = args[0];
	if (action === "list" && args.length === 1) {
		return Object.freeze({ kind: "hooks", action, json });
	}
	if ((action === "inspect" || action === "approve" || action === "revoke")
		&& args.length === 2) {
		return Object.freeze({ kind: "hooks", action, identity: nonEmpty(args[1]), json });
	}
	throw usage("hooks list|inspect|approve|revoke [identity] [--json]");
}

function parsePlugins(args: readonly string[], json: boolean): PluginsManagementCommand {
	const action = args[0];
	if (action === "list" && args.length === 1) {
		return Object.freeze({ kind: "plugins", action, json });
	}
	if (action === "inspect" && args.length === 2) {
		return Object.freeze({ kind: "plugins", action, pluginId: nonEmpty(args[1]), json });
	}
	if (action !== "run") throw pluginUsage();
	const extracted = extractOption(args.slice(1), "--json-args");
	if (extracted.args.length !== 2) throw pluginUsage();
	return Object.freeze({
		kind: "plugins",
		action,
		pluginId: nonEmpty(extracted.args[0]),
		commandName: nonEmpty(extracted.args[1]),
		arguments: parseJsonArguments(extracted.value),
		json,
	});
}

function parseMcp(args: readonly string[], json: boolean): McpManagementCommand {
	const action = args[0];
	if (action === "list" && args.length === 1) {
		return Object.freeze({ kind: "mcp", action, json });
	}
	if (action === "inspect" && args.length === 2) {
		return Object.freeze({ kind: "mcp", action, serverId: nonEmpty(args[1]), json });
	}
	throw usage("mcp list|inspect [server_id] [--json]");
}

function parseJsonArguments(value: string | undefined): Readonly<Record<string, unknown>> {
	if (value === undefined) return Object.freeze({});
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("invalid_json_arguments: --json-args must be a JSON object");
	}
	if (!isRecord(parsed)) {
		throw new Error("invalid_json_arguments: --json-args must be a JSON object");
	}
	return Object.freeze({ ...parsed });
}

function extractFlag(
	args: readonly string[],
	flag: string,
): { readonly args: readonly string[]; readonly json: boolean } {
	const remaining: string[] = [];
	let seen = false;
	for (const argument of args) {
		if (argument !== flag) {
			remaining.push(argument);
			continue;
		}
		if (seen) throw new Error(`invalid_arguments: duplicate ${flag}`);
		seen = true;
	}
	return { args: Object.freeze(remaining), json: seen };
}

function extractOption(
	args: readonly string[],
	option: string,
): { readonly args: readonly string[]; readonly value?: string } {
	const remaining: string[] = [];
	let value: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument !== option) {
			remaining.push(argument!);
			continue;
		}
		if (value !== undefined || args[index + 1] === undefined) throw pluginUsage();
		value = args[index + 1];
		index += 1;
	}
	return {
		args: Object.freeze(remaining),
		...(value === undefined ? {} : { value }),
	};
}

function validateInteractiveArguments(argv: readonly string[]): void {
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--session" || argument === "--model"
			|| argument === "--profile" || argument === "-p") {
			if (!argv[index + 1]) throw new Error(`invalid_arguments: ${argument} requires a value`);
			index += 1;
			continue;
		}
		if (argument?.startsWith("--session=")
			|| argument?.startsWith("--model=")
			|| argument?.startsWith("--profile=")
			|| argument?.startsWith("-p=")) {
			if (!argument.slice(argument.indexOf("=") + 1)) {
				throw new Error(`invalid_arguments: ${argument.slice(0, argument.indexOf("="))} requires a value`);
			}
			continue;
		}
		throw new Error("invalid_arguments: unsupported command or option");
	}
}

function nonEmpty(value: string | undefined): string {
	if (!value?.trim()) throw new Error("invalid_arguments: command argument must be non-empty");
	return value;
}

function pluginUsage(): Error {
	return usage("plugins list|inspect|run [plugin_id] [command] [--json-args JSON] [--json]");
}

function configUsage(): Error {
	return usage(
		"config validate|show|get|set|unset|path|migrate [arguments] [--json]",
	);
}

function doctorUsage(): Error {
	return usage(
		"doctor [--verbose] [--json] [--fix [--confirm <plan-id>] | --support-bundle]",
	);
}

function sessionUsage(): Error {
	return usage("session list|resume|fork|rename|archive|unarchive|delete|export [options]");
}

function authUsage(): Error {
	return usage(
		"login status|--with-api-key [--provider <id>] [--auth-ref <ref>] [--json] | logout [--provider <id>] [--auth-ref <ref>] [--json]",
	);
}

function setupUsage(): Error {
	return usage(
		"setup [--non-interactive --provider <id> [--model <model>] [--base-url <url>] --with-api-key [--json]]",
	);
}

function usage(command: string): Error {
	return new Error(`invalid_arguments: usage: mycli ${command}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
