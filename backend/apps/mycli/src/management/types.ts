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

export type ConfigManagementCommand =
	| {
		readonly kind: "config";
		readonly action: "validate" | "show";
		readonly json: boolean;
	}
	| {
		readonly kind: "config";
		readonly action: "get" | "unset";
		readonly key: string;
		readonly json: boolean;
	}
	| {
		readonly kind: "config";
		readonly action: "set";
		readonly key: string;
		readonly value: string;
		readonly json: boolean;
	};

export type SandboxManagementCommand = {
	readonly kind: "sandbox";
	readonly action: "status";
	readonly json: boolean;
};

export type ManagementCommand =
	| { readonly kind: "doctor"; readonly json: boolean }
	| { readonly kind: "setup"; readonly json: boolean }
	| SandboxManagementCommand
	| ConfigManagementCommand
	| HooksManagementCommand
	| PluginsManagementCommand
	| McpManagementCommand;

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
