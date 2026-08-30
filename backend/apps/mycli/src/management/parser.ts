import type {
	CliMode,
	ConfigManagementCommand,
	HooksManagementCommand,
	ManagementCommand,
	McpManagementCommand,
	PluginsManagementCommand,
	SessionManagementCommand,
} from "./types.ts";

const MANAGEMENT_COMMANDS = new Set([
	"config",
	"doctor",
	"setup",
	"sandbox",
	"hooks",
	"plugins",
	"mcp",
	"session",
]);

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
		if (rawArgs.length > 0) throw usage("setup");
		return Object.freeze({ kind: "setup", json: false });
	}
	const { args, json } = extractFlag(rawArgs, "--json");
	if (root === "doctor") {
		if (args.length > 0) throw usage("doctor [--json]");
		return Object.freeze({ kind: "doctor", json });
	}
	if (root === "sandbox") {
		if (args.length !== 1 || args[0] !== "status") {
			throw usage("sandbox status [--json]");
		}
		return Object.freeze({ kind: "sandbox", action: "status", json });
	}
	if (root === "config") return parseConfig(args, json);
	if (root === "hooks") return parseHooks(args, json);
	if (root === "plugins") return parsePlugins(args, json);
	if (root === "mcp") return parseMcp(args, json);
	return parseSession(args, json);
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
	if ((action === "validate" || action === "show") && args.length === 1) {
		return Object.freeze({ kind: "config", action, json });
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
	throw configUsage();
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
		if (argument === "--session" || argument === "--model") {
			if (!argv[index + 1]) throw new Error(`invalid_arguments: ${argument} requires a value`);
			index += 1;
			continue;
		}
		if (argument?.startsWith("--session=")
			|| argument?.startsWith("--model=")) {
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
	return usage("config validate|show|get|set|unset [key] [value] [--json]");
}

function sessionUsage(): Error {
	return usage("session list|resume|fork|rename|archive|unarchive|delete|export [options]");
}

function usage(command: string): Error {
	return new Error(`invalid_arguments: usage: mycli ${command}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
