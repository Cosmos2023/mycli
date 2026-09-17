import type { McpManagementCommand } from "./types.ts";

export function parseMcpManagement(raw: readonly string[]): McpManagementCommand {
	const separator = raw.indexOf("--");
	const options = separator < 0 ? raw : raw.slice(0, separator);
	const processArgs = separator < 0 ? [] : raw.slice(separator + 1);
	const json = options.includes("--json");
	if (options.filter((value) => value === "--json").length > 1) throw usage();
	const args = options.filter((value) => value !== "--json");
	const action = args[0];
	if (separator < 0 && (action === "list" || action === "approvals") && args.length === 1) return { kind: "mcp", action, json };
	if (separator < 0 && (action === "inspect" || action === "remove" || action === "revoke" || action === "login" || action === "logout") && args.length === 2 && args[1]?.trim()) {
		return { kind: "mcp", action, serverId: args[1], json };
	}
	if (action !== "add" || !args[1]?.trim()) throw usage();
	const config: Record<string, unknown> = {};
	const strings: Readonly<Record<string, string>> = { "--url": "url", "--cwd": "cwd",
		"--bearer-token-env-var": "bearer_token_env_var", "--approval-mode": "default_tools_approval_mode" };
	for (let index = 2; index < args.length; index += 1) {
		const option = args[index]!;
		if (option === "--required") { if (config.required) throw usage(); config.required = true; continue; }
		const value = args[++index];
		if (value === undefined) throw usage();
		if (Object.hasOwn(strings, option)) {
			if (config[strings[option]!] !== undefined) throw usage();
			config[strings[option]!] = value;
		} else if (option === "--startup-timeout-sec" || option === "--tool-timeout-sec") {
			const key = option === "--startup-timeout-sec" ? "startup_timeout_sec" : "tool_timeout_sec";
			if (config[key] !== undefined) throw usage();
			config[key] = Number(value);
		} else if (option === "--enabled-tool" || option === "--disabled-tool") {
			const key = option === "--enabled-tool" ? "enabled_tools" : "disabled_tools";
			const values = config[key] as string[] | undefined;
			config[key] = [...(values ?? []), value];
		} else if (option === "--network" || option === "--sandbox-mode") {
			const sandbox = config.sandbox as Record<string, string> | undefined ?? {};
			const key = option === "--network" ? "network" : "mode";
			if (sandbox[key] !== undefined) throw usage();
			sandbox[key] = value;
			config.sandbox = sandbox;
		} else if (option === "--env" || option === "--header") {
			const split = value.indexOf("=");
			if (split <= 0) throw usage();
			const key = option === "--env" ? "env" : "headers";
			const table = config[key] as Record<string, string> | undefined ?? {};
			if (Object.hasOwn(table, value.slice(0, split))) throw usage();
			config[key] = { ...table, [value.slice(0, split)]: value.slice(split + 1) };
		} else throw usage();
	}
	if (config.url !== undefined) {
		if (separator >= 0) throw usage();
		config.transport = "streamable_http";
	} else {
		if (!processArgs[0]) throw usage();
		config.transport = "stdio";
		config.command = processArgs[0];
		config.args = processArgs.slice(1);
	}
	return { kind: "mcp", action: "add", serverId: args[1], config, json };
}

function usage(): Error {
	return new Error("invalid_arguments: usage: mycli mcp list|inspect|remove|approvals|revoke|login|logout; mycli mcp add <server> [options] (--url <url> | -- <command> [args...])");
}
