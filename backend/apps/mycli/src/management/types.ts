import type { ConfigPathScope } from "@mycli/config/paths";

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
		readonly action: "validate";
		readonly strict?: boolean;
		readonly json: boolean;
	}
	| {
		readonly kind: "config";
		readonly action: "show";
		readonly json: boolean;
	}
	| {
		readonly kind: "config";
		readonly action: "path";
		readonly scope: ConfigPathScope;
		readonly profile?: string;
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
	}
	| {
		readonly kind: "config";
		readonly action: "migrate";
		readonly operation: "preview";
		readonly json: boolean;
	}
	| {
		readonly kind: "config";
		readonly action: "migrate";
		readonly operation: "apply";
		readonly expectedVersion: string;
		readonly json: boolean;
	}
	| {
		readonly kind: "config";
		readonly action: "migrate";
		readonly operation: "rollback";
		readonly backupId: string;
		readonly json: boolean;
	};

export type SandboxManagementCommand = {
	readonly kind: "sandbox";
	readonly action: "status";
	readonly json: boolean;
};

export type UpdateManagementCommand =
	| { readonly kind: "update"; readonly action: "status" | "check"; readonly json: boolean }
	| {
		readonly kind: "update";
		readonly action: "dismiss";
		readonly version: string;
		readonly json: boolean;
	};

export type SessionManagementCommand =
	| {
		readonly kind: "session";
		readonly action: "list";
		readonly json: boolean;
		readonly all: boolean;
		readonly last: boolean;
		readonly workspaceRoot?: string;
		readonly search?: string;
		readonly model?: string;
		readonly collaborationMode?: "default" | "plan";
		readonly permissionProfile?: "read-only" | "workspace" | "full-access";
		readonly status?: "active" | "archived" | "deleted" | "waiting_approval"
			| "waiting_clarification" | "interrupted";
		readonly limit?: number;
	}
	| {
		readonly kind: "session";
		readonly action: "fork";
		readonly sessionId: string;
		readonly targetSessionId?: string;
		readonly json: boolean;
	}
	| {
		readonly kind: "session";
		readonly action: "rename";
		readonly sessionId: string;
		readonly title: string;
		readonly json: boolean;
	}
	| {
		readonly kind: "session";
		readonly action: "archive" | "unarchive";
		readonly sessionId: string;
		readonly json: boolean;
	}
	| {
		readonly kind: "session";
		readonly action: "delete";
		readonly sessionId: string;
		readonly force: boolean;
		readonly json: boolean;
	}
	| {
		readonly kind: "session";
		readonly action: "export";
		readonly sessionId: string;
		readonly json: boolean;
	};

export type ManagementCommand =
	| { readonly kind: "doctor"; readonly json: boolean; readonly verbose: boolean }
	| { readonly kind: "setup"; readonly json: boolean }
	| SandboxManagementCommand
	| UpdateManagementCommand
	| ConfigManagementCommand
	| HooksManagementCommand
	| PluginsManagementCommand
	| McpManagementCommand
	| SessionManagementCommand;

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
