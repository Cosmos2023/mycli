import type {
	CliMode,
	ConfigManagementCommand,
	HooksManagementCommand,
	ManagementCommand,
	McpManagementCommand,
	PluginsManagementCommand,
} from "./types.ts";

const MANAGEMENT_COMMANDS = new Set(["config", "doctor", "setup", "hooks", "plugins", "mcp"]);

export function parseCliMode(argv: readonly string[]): CliMode {
	const root = argv[0];
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
	if (root === "config") return parseConfig(args, json);
	if (root === "hooks") return parseHooks(args, json);
	if (root === "plugins") return parsePlugins(args, json);
	return parseMcp(args, json);
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

function usage(command: string): Error {
	return new Error(`invalid_arguments: usage: mycli ${command}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
