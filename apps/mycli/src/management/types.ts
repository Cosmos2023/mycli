export type HooksManagementCommand =
	| { readonly kind: "hooks"; readonly action: "list"; readonly json: boolean }
	| {
		readonly kind: "hooks";
		readonly action: "inspect" | "approve" | "revoke";
		readonly identity: string;
		readonly json: boolean;
	};

export type PluginsManagementCommand =
	| { readonly kind: "plugins"; readonly action: "list"; readonly json: boolean }
	| {
		readonly kind: "plugins";
		readonly action: "inspect";
		readonly pluginId: string;
		readonly json: boolean;
	}
	| {
		readonly kind: "plugins";
		readonly action: "run";
		readonly pluginId: string;
		readonly commandName: string;
		readonly arguments: Readonly<Record<string, unknown>>;
		readonly json: boolean;
	};

export type McpManagementCommand =
	| { readonly kind: "mcp"; readonly action: "list"; readonly json: boolean }
	| {
		readonly kind: "mcp";
		readonly action: "inspect";
		readonly serverId: string;
		readonly json: boolean;
	};

export type SubagentsManagementCommand =
	| { readonly kind: "subagents"; readonly action: "list"; readonly json: boolean }
	| {
		readonly kind: "subagents";
		readonly action: "inspect";
		readonly profileId: string;
		readonly json: boolean;
	};

export type ManagementCommand =
	| { readonly kind: "doctor"; readonly json: boolean }
	| { readonly kind: "setup"; readonly json: boolean }
	| HooksManagementCommand
	| PluginsManagementCommand
	| McpManagementCommand
	| SubagentsManagementCommand;

export type CliMode =
	| { readonly kind: "interactive"; readonly runtimeArgs: readonly string[] }
	| { readonly kind: "management"; readonly command: ManagementCommand };

export interface ManagementResponse {
	readonly ok: boolean;
	readonly action: string;
	readonly message?: string;
	readonly issues?: readonly string[];
	readonly exitCode?: number;
}

export interface ManagementExecutor {
	execute(command: ManagementCommand, signal?: AbortSignal): Promise<ManagementResponse>;
}
