import type { McpProcessPermissions, McpServerConfig, McpToolAnnotations, McpToolApprovalMode } from "./types.ts";

export class McpConfigError extends Error {
	readonly errorClass: string;
	constructor(errorClass: string) { super(errorClass); this.errorClass = errorClass; }
}

export function mcpExtendedConfig(raw: Readonly<Record<string, unknown>>): Pick<McpServerConfig, "startupTimeoutMs" | "toolTimeoutMs" | "required" | "enabledTools" | "disabledTools" | "defaultToolsApprovalMode" | "tools" | "sandbox" | "cwd" | "oauth"> {
	const startupTimeoutMs = timeoutSeconds(raw.startup_timeout_sec);
	const toolTimeoutMs = timeoutSeconds(raw.tool_timeout_sec);
	const required = raw.required;
	if (required !== undefined && typeof required !== "boolean") throw new McpConfigError("invalid_required");
	const enabledTools = toolNames(raw.enabled_tools);
	const disabledTools = toolNames(raw.disabled_tools);
	const defaultToolsApprovalMode = approvalMode(raw.default_tools_approval_mode);
	const tools = toolSettings(raw.tools);
	const sandbox = processPermissions(raw.sandbox);
	const oauth = oauthSettings(raw.oauth);
	if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || !raw.cwd.trim() || raw.cwd.length > 4_096)) {
		throw new McpConfigError("invalid_cwd");
	}
	return {
		...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
		...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
		...(required === undefined ? {} : { required }),
		...(enabledTools === undefined ? {} : { enabledTools }),
		...(disabledTools === undefined ? {} : { disabledTools }),
		...(defaultToolsApprovalMode === undefined ? {} : { defaultToolsApprovalMode }),
		...(tools === undefined ? {} : { tools }),
		...(sandbox === undefined ? {} : { sandbox }),
		...(oauth === undefined ? {} : { oauth }),
		...(typeof raw.cwd === "string" ? { cwd: raw.cwd.trim() } : {}),
	};
}

function oauthSettings(value: unknown): McpServerConfig["oauth"] {
	if (value === undefined) return undefined;
	if (!record(value) || Object.keys(value).some((key) => !["client_id", "scopes", "callback_port"].includes(key))
		|| value.client_id !== undefined && (typeof value.client_id !== "string" || !value.client_id.trim() || value.client_id.length > 2_048)
		|| value.scopes !== undefined && (!Array.isArray(value.scopes) || value.scopes.length > 64
			|| value.scopes.some((scope) => typeof scope !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/u.test(scope)))
		|| value.callback_port !== undefined && (!Number.isSafeInteger(value.callback_port) || Number(value.callback_port) < 1 || Number(value.callback_port) > 65_535)) {
		throw new McpConfigError("invalid_mcp_oauth");
	}
	return Object.freeze({ ...(typeof value.client_id === "string" ? { clientId: value.client_id } : {}),
		...(Array.isArray(value.scopes) ? { scopes: Object.freeze([...new Set(value.scopes as string[])]) } : {}),
		...(value.callback_port === undefined ? {} : { callbackPort: Number(value.callback_port) }) });
}

export function mcpToolEnabled(config: McpServerConfig, name: string): boolean {
	return (config.enabledTools === undefined || config.enabledTools.includes(name))
		&& !config.disabledTools?.includes(name);
}

export function parseMcpAnnotations(value: unknown): McpToolAnnotations | undefined {
	if (!record(value)) return undefined;
	const hints: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } = {};
	if (typeof value.title === "string") hints.title = value.title.slice(0, 512);
	for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
		if (typeof value[key] === "boolean") hints[key] = value[key];
	}
	return Object.keys(hints).length ? Object.freeze(hints) : undefined;
}

function timeoutSeconds(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 300) throw new McpConfigError("invalid_timeout");
	return Math.max(1, Math.round(value * 1_000));
}

function toolNames(value: unknown): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > 512 || value.some((name) => !validToolName(name))) throw new McpConfigError("invalid_tool_filter");
	return Object.freeze([...new Set(value as string[])]);
}

function validToolName(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function approvalMode(value: unknown): McpToolApprovalMode | undefined {
	if (value === undefined || value === "auto" || value === "prompt" || value === "approve") return value;
	throw new McpConfigError("invalid_tool_approval_mode");
}

function toolSettings(value: unknown): McpServerConfig["tools"] {
	if (value === undefined) return undefined;
	if (!record(value) || Object.keys(value).length > 512) throw new McpConfigError("invalid_tool_settings");
	return Object.freeze(Object.fromEntries(Object.entries(value).map(([name, settings]) => {
		if (!validToolName(name) || !record(settings) || Object.keys(settings).some((key) => key !== "approval_mode")) throw new McpConfigError("invalid_tool_settings");
		const mode = approvalMode(settings.approval_mode);
		return [name, Object.freeze(mode === undefined ? {} : { approvalMode: mode })];
	})));
}

function processPermissions(value: unknown): McpProcessPermissions | undefined {
	if (value === undefined) return undefined;
	if (!record(value) || Object.keys(value).some((key) => key !== "mode" && key !== "network")
		|| value.mode !== undefined && value.mode !== "read-only" && value.mode !== "workspace-write"
		|| value.network !== undefined && value.network !== "enabled" && value.network !== "disabled") throw new McpConfigError("invalid_mcp_sandbox");
	return Object.freeze({ ...(value.mode === undefined ? {} : { mode: value.mode }),
		...(value.network === undefined ? {} : { network: value.network }) });
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
