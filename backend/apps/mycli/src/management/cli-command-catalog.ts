export const COMPLETION_SHELLS = Object.freeze([
	"bash",
	"zsh",
	"fish",
	"powershell",
] as const);

export type CompletionShell = typeof COMPLETION_SHELLS[number];
type CliCommandExecution = "management" | "completion" | "headless" | "app-server";

export interface CliArgumentDescriptor {
	readonly name: string;
	readonly description: string;
	readonly values?: readonly string[];
}

export interface CliOptionDescriptor {
	readonly flags: readonly string[];
	readonly description: string;
	readonly value?: CliArgumentDescriptor;
}

export interface CliCommandNode {
	readonly name: string;
	readonly description: string;
	readonly arguments?: readonly CliArgumentDescriptor[];
	readonly options?: readonly CliOptionDescriptor[];
	readonly subcommands?: readonly CliCommandNode[];
}

export interface CliCommandDescriptor extends CliCommandNode {
	readonly execution: CliCommandExecution;
	readonly usage: string;
}

const JSON_OPTION: CliOptionDescriptor = {
	flags: ["--json"],
	description: "Write stable JSON output",
};

const PROVIDER_OPTION: CliOptionDescriptor = {
	flags: ["--provider"],
	description: "Select a configured provider",
	value: { name: "id", description: "Provider id" },
};

const AUTH_REF_OPTION: CliOptionDescriptor = {
	flags: ["--auth-ref"],
	description: "Select a credential reference",
	value: { name: "ref", description: "Credential reference" },
};

const SESSION_ID_ARGUMENT: CliArgumentDescriptor = {
	name: "session-id",
	description: "Session id",
};

export const ROOT_CLI_OPTIONS = Object.freeze([
	{
		flags: ["--session"],
		description: "Resume or create a session",
		value: { name: "id", description: "Session id" },
	},
	{
		flags: ["--model"],
		description: "Override the configured model",
		value: { name: "model", description: "Model id" },
	},
	{
		flags: ["-p", "--profile"],
		description: "Select a launch-scoped configuration profile",
		value: { name: "name", description: "Profile name" },
	},
	{ flags: ["-h", "--help"], description: "Show help" },
	{ flags: ["-V", "--version"], description: "Show version" },
] satisfies readonly CliOptionDescriptor[]);

export const CLI_COMMAND_CATALOG: readonly CliCommandDescriptor[] = Object.freeze([
	{
		name: "app-server", usage: "app-server [--session id] [--model model] [--profile name]",
		description: "Serve the agent protocol over stdio", execution: "app-server",
		options: ROOT_CLI_OPTIONS.slice(0, 3),
	},
	{
		name: "exec", usage: "exec [options] [prompt|-]",
		description: "Run one task without a terminal", execution: "headless",
		arguments: [{ name: "prompt", description: "Task text, or - for stdin" }],
		options: [
			...ROOT_CLI_OPTIONS.slice(0, 3),
			{ flags: ["--json"], description: "Write versioned JSONL task events" },
			valueOption("--output-schema", "file", "Validate the final JSON answer against a schema"),
			{ flags: ["-o", "--output-last-message"], description: "Write the validated final answer", value: { name: "file", description: "Output file" } },
			valueOption("--timeout", "seconds", "Stop after this duration (default: 600)"),
		],
	},
	{
		name: "review", usage: "review [--uncommitted|--base ref|--commit ref] [instructions]",
		description: "Review Git changes with a read-only agent", execution: "headless",
		arguments: [{ name: "instructions", description: "Optional review focus" }],
		options: [
			{ flags: ["--uncommitted"], description: "Review staged, unstaged, and untracked changes (default)" },
			valueOption("--base", "ref", "Review HEAD changes since the merge base"),
			valueOption("--commit", "ref", "Review one commit"),
			...ROOT_CLI_OPTIONS.slice(1, 3),
			{ flags: ["--json"], description: "Write versioned JSONL review events and findings" },
			{ flags: ["-o", "--output-last-message"], description: "Write validated findings as JSON", value: { name: "file", description: "Output file" } },
			valueOption("--timeout", "seconds", "Stop after this duration (default: 600)"),
		],
	},
	{
		name: "setup",
		usage: "setup [options]",
		description: "Configure provider settings and credentials",
		execution: "management",
		options: [
			{
				flags: ["--non-interactive"],
				description: "Configure without an interactive prompt",
			},
			PROVIDER_OPTION,
			{
				flags: ["--model"],
				description: "Select the provider model",
				value: { name: "model", description: "Model id" },
			},
			{
				flags: ["--base-url"],
				description: "Set the provider API endpoint",
				value: { name: "url", description: "API base URL" },
			},
			{
				flags: ["--with-api-key"],
				description: "Read an API key from standard input",
			},
			JSON_OPTION,
		],
	},
	{
		name: "login",
		usage: "login status [--json] | --with-api-key | --oauth",
		description: "Inspect credentials, store an API key, or sign in with OAuth",
		execution: "management",
		options: [
			{
				flags: ["--with-api-key"],
				description: "Read an API key from standard input",
			},
			{ flags: ["--oauth"], description: "Sign in through the native provider OAuth flow" },
			PROVIDER_OPTION,
			AUTH_REF_OPTION,
			JSON_OPTION,
		],
		subcommands: [
			{
				name: "status",
				description: "Inspect the selected credential source",
				options: [PROVIDER_OPTION, AUTH_REF_OPTION, JSON_OPTION],
			},
		],
	},
	{
		name: "logout",
		usage: "logout [--json]",
		description: "Remove a locally stored API key or OAuth credential",
		execution: "management",
		options: [PROVIDER_OPTION, AUTH_REF_OPTION, JSON_OPTION],
	},
	{
		name: "config",
		usage: "config <action> [arguments]",
		description: "Validate, inspect, migrate, or locate configuration",
		execution: "management",
		subcommands: [
			{
				name: "validate",
				description: "Validate the effective configuration",
				options: [
					{ flags: ["--strict"], description: "Fail when warnings remain" },
					JSON_OPTION,
				],
			},
			{
				name: "show",
				description: "Show effective configuration metadata",
				options: [JSON_OPTION],
			},
			{
				name: "get",
				description: "Read one canonical scalar setting",
				arguments: [{ name: "key", description: "Configuration key" }],
				options: [JSON_OPTION],
			},
			{
				name: "set",
				description: "Set one canonical scalar setting",
				arguments: [
					{ name: "key", description: "Configuration key" },
					{ name: "value", description: "Configuration value" },
				],
				options: [JSON_OPTION],
			},
			{
				name: "unset",
				description: "Remove one user configuration setting",
				arguments: [{ name: "key", description: "Configuration key" }],
				options: [JSON_OPTION],
			},
			{
				name: "path",
				description: "Locate a configuration layer",
				arguments: [{
					name: "scope",
					description: "Configuration scope",
					values: ["user", "project", "profile", "system", "legacy_user"],
				}],
				options: [
					{
						flags: ["--profile"],
						description: "Select a profile configuration",
						value: { name: "name", description: "Profile name" },
					},
					JSON_OPTION,
				],
			},
			{
				name: "migrate",
				description: "Preview, apply, or roll back configuration migration",
				options: [
					{ flags: ["--dry-run"], description: "Preview migration without writing" },
					{ flags: ["--apply"], description: "Apply the previewed migration" },
					{
						flags: ["--expected-version"],
						description: "Require the previewed configuration version",
						value: { name: "version", description: "Migration version" },
					},
					{
						flags: ["--rollback"],
						description: "Restore a migration backup",
						value: { name: "backup-id", description: "Backup id" },
					},
					JSON_OPTION,
				],
			},
		],
	},
	{
		name: "doctor",
		usage: "doctor [options]",
		description: "Check health, preview repairs, or export support data",
		execution: "management",
		options: [
			JSON_OPTION,
			{ flags: ["--verbose"], description: "Include bounded diagnostic detail" },
			{ flags: ["--fix"], description: "Preview or apply safe repairs" },
			{
				flags: ["--confirm"],
				description: "Apply the exact previewed repair plan",
				value: { name: "plan-id", description: "Repair plan id" },
			},
			{ flags: ["--support-bundle"], description: "Export bounded support data" },
		],
	},
	{
		name: "update",
		usage: "update [status|check|dismiss <version>] [--json]",
		description: "Inspect or dismiss cached update notices",
		execution: "management",
		options: [JSON_OPTION],
		subcommands: [
			{ name: "status", description: "Read cached update status", options: [JSON_OPTION] },
			{ name: "check", description: "Refresh update status", options: [JSON_OPTION] },
			{
				name: "dismiss",
				description: "Dismiss one exact advertised version",
				arguments: [{ name: "version", description: "Advertised version" }],
				options: [JSON_OPTION],
			},
		],
	},
	{
		name: "sandbox",
		usage: "sandbox status|setup|reset [--confirm] [--json]",
		description: "Inspect or recover platform sandbox readiness",
		execution: "management",
		subcommands: [
			{ name: "status", description: "Inspect sandbox readiness", options: [JSON_OPTION] },
			{
				name: "setup",
				description: "Preview or perform sandbox setup",
				options: [
					{ flags: ["--confirm"], description: "Perform the previewed setup" },
					JSON_OPTION,
				],
			},
			{
				name: "reset",
				description: "Preview or reset mycli sandbox state",
				options: [
					{ flags: ["--confirm"], description: "Perform the previewed reset" },
					JSON_OPTION,
				],
			},
		],
	},
	{
		name: "hooks",
		usage: "hooks list|inspect|approve|revoke [identity] [--json]",
		description: "Manage configured hooks",
		execution: "management",
		subcommands: [
			{ name: "list", description: "List configured hooks", options: [JSON_OPTION] },
			...identitySubcommands(["inspect", "approve", "revoke"]),
		],
	},
	{
		name: "plugins",
		usage: "plugins list|inspect|run|add|remove|enable|disable|update|marketplace [arguments]",
		description: "Manage plugins and marketplaces",
		execution: "management",
		subcommands: [
			{ name: "list", description: "List installed or available plugins", options: [JSON_OPTION,
				{ flags: ["--available"], description: "List marketplace entries" },
				{ flags: ["--marketplace"], description: "Select a marketplace", value: { name: "name", description: "Marketplace name" } },
			] },
			{ name: "add", description: "Install a plugin package", arguments: [{ name: "source", description: "Local directory, Git source, or name@marketplace" }],
				options: [JSON_OPTION,
					{ flags: ["--marketplace"], description: "Install from a marketplace", value: { name: "name", description: "Marketplace name" } },
					{ flags: ["--ref"], description: "Select a Git branch or tag", value: { name: "ref", description: "Git ref" } },
				] },
			...["remove", "enable", "disable", "update"].map((name) => ({ name, description: `${name} a plugin`,
				arguments: [{ name: "plugin-id", description: "Plugin id" }], options: [JSON_OPTION] })),
			{ name: "marketplace", description: "Manage plugin marketplaces", subcommands: [
				{ name: "list", description: "List configured marketplaces", options: [JSON_OPTION] },
				{ name: "add", description: "Add a marketplace", arguments: [{ name: "source", description: "Local directory or Git source" }], options: [JSON_OPTION,
					{ flags: ["--ref"], description: "Select a Git branch or tag", value: { name: "ref", description: "Git ref" } },
				] },
				...["remove", "upgrade"].map((name) => ({ name, description: `${name} a marketplace`,
					arguments: [{ name: "name", description: "Marketplace name" }], options: [JSON_OPTION] })),
			] },
			{
				name: "inspect",
				description: "Inspect one local plugin",
				arguments: [{ name: "plugin-id", description: "Plugin id" }],
				options: [JSON_OPTION],
			},
			{
				name: "run",
				description: "Run one declared plugin command",
				arguments: [
					{ name: "plugin-id", description: "Plugin id" },
					{ name: "command", description: "Declared command name" },
				],
				options: [
					{
						flags: ["--json-args"],
						description: "Pass one JSON object to the plugin command",
						value: { name: "json", description: "JSON object" },
					},
					JSON_OPTION,
				],
			},
		],
	},
	{
		name: "mcp",
		usage: "mcp list|inspect [server-id] [--json]",
		description: "Inspect MCP servers",
		execution: "management",
		subcommands: [
			{ name: "list", description: "List configured MCP servers", options: [JSON_OPTION] },
			{
				name: "inspect",
				description: "Inspect one configured MCP server",
				arguments: [{ name: "server-id", description: "MCP server id" }],
				options: [JSON_OPTION],
			},
		],
	},
	{
		name: "session",
		usage: "session <action> [arguments]",
		description: "Discover and manage local sessions",
		execution: "management",
		subcommands: [
			{
				name: "list",
				description: "List local sessions",
				options: [
					{ flags: ["--all"], description: "Include sessions from every workspace" },
					{ flags: ["--last"], description: "Select the most recent matching session" },
					valueOption("--workspace", "path", "Filter by workspace root"),
					valueOption("--search", "query", "Filter by title or transcript text"),
					valueOption("--model", "model", "Filter by model id"),
					valueOption("--mode", "mode", "Filter by collaboration mode", ["default", "plan"]),
					valueOption(
						"--permission",
						"profile",
						"Filter by permission profile",
						["read-only", "workspace", "full-access"],
					),
					valueOption(
						"--status",
						"status",
						"Filter by lifecycle status",
						[
							"active",
							"archived",
							"deleted",
							"waiting_approval",
							"waiting_clarification",
							"interrupted",
						],
					),
					valueOption("--limit", "count", "Limit returned sessions"),
					JSON_OPTION,
				],
			},
			{
				name: "resume",
				description: "Resume a session in the interactive TUI",
				arguments: [SESSION_ID_ARGUMENT],
			},
			{
				name: "fork",
				description: "Fork a session",
				arguments: [
					SESSION_ID_ARGUMENT,
					{ name: "target-session-id", description: "Optional target session id" },
				],
				options: [JSON_OPTION],
			},
			{
				name: "rename",
				description: "Rename a session",
				arguments: [SESSION_ID_ARGUMENT, { name: "title", description: "New title" }],
				options: [JSON_OPTION],
			},
			...sessionIdSubcommands(["archive", "unarchive", "export"]),
			{
				name: "delete",
				description: "Delete a session",
				arguments: [SESSION_ID_ARGUMENT],
				options: [
					{ flags: ["--force"], description: "Confirm destructive deletion" },
					JSON_OPTION,
				],
			},
		],
	},
	{
		name: "completion",
		usage: "completion <bash|zsh|fish|powershell>",
		description: "Generate shell completion for mycli",
		execution: "completion",
		arguments: [{
			name: "shell",
			description: "Shell name",
			values: COMPLETION_SHELLS,
		}],
	},
] satisfies readonly CliCommandDescriptor[]);

export const CLI_COMMAND_NAMES = Object.freeze(
	CLI_COMMAND_CATALOG.map((command) => command.name),
);

export const MANAGEMENT_COMMAND_NAMES = Object.freeze(
	CLI_COMMAND_CATALOG
		.filter((command) => command.execution === "management")
		.map((command) => command.name),
);

export function findCliCommand(name: string | undefined): CliCommandDescriptor | undefined {
	return CLI_COMMAND_CATALOG.find((command) => command.name === name);
}

export function renderRootHelp(): string {
	return [
		"Usage: mycli [options]",
		"       mycli <command> [arguments]",
		"",
		"Commands:",
		...CLI_COMMAND_CATALOG.flatMap((command) => formatHelpEntry(command.usage, command.description)),
		"Options:",
		...ROOT_CLI_OPTIONS.flatMap((option) => formatHelpEntry(
			optionUsage(option),
			option.description,
		)),
		"",
	].join("\n");
}

export function renderCommandHelp(name: string): string {
	const command = findCliCommand(name);
	if (!command) return renderRootHelp();
	return [
		`Usage: mycli ${command.usage}`, "", command.description, "", "Options:",
		...(command.options ?? []).flatMap((option) => formatHelpEntry(optionUsage(option), option.description)),
		"  -h, --help                          Show help", "",
	].join("\n");
}

function identitySubcommands(
	names: readonly ("inspect" | "approve" | "revoke")[],
): readonly CliCommandNode[] {
	return names.map((name) => ({
		name,
		description: `${titleCase(name)} one configured hook`,
		arguments: [{ name: "identity", description: "Hook identity" }],
		options: [JSON_OPTION],
	}));
}

function sessionIdSubcommands(
	names: readonly ("archive" | "unarchive" | "export")[],
): readonly CliCommandNode[] {
	return names.map((name) => ({
		name,
		description: `${titleCase(name)} a session`,
		arguments: [SESSION_ID_ARGUMENT],
		options: [JSON_OPTION],
	}));
}

function valueOption(
	flag: string,
	name: string,
	description: string,
	values?: readonly string[],
): CliOptionDescriptor {
	return {
		flags: [flag],
		description,
		value: { name, description, ...(values ? { values } : {}) },
	};
}

function optionUsage(option: CliOptionDescriptor): string {
	const flags = option.flags.join(", ");
	return option.value ? `${flags} <${option.value.name}>` : flags;
}

function formatHelpEntry(usage: string, description: string): readonly string[] {
	const indentation = " ".repeat(38);
	const command = `  ${usage}`;
	if (command.length >= indentation.length) {
		return [command, `${indentation}${description}`];
	}
	return [`${command.padEnd(indentation.length)}${description}`];
}

function titleCase(value: string): string {
	return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
