import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

/** Where a role file came from. A repository role overrides a user role with the same name. */
export type AgentRoleSourceKind = "user" | "repo";

/** A declared subagent: what it is for, and how it differs from its caller. */
export interface AgentRole {
	readonly name: string;
	readonly description: string;
	readonly sourcePath: string;
	readonly sourceKind: AgentRoleSourceKind;
	/** Model override. Omitted means the child inherits the caller's model. */
	readonly model?: string;
	/** Tool allowlist, intersected with what the caller may already delegate. */
	readonly tools?: readonly string[];
}

export interface AgentRoleDiagnosticIssue {
	readonly sourceKind: AgentRoleSourceKind;
	readonly fileLabel: string;
	readonly errorClass: string;
}

export interface AgentRoleCatalog {
	readonly roles: readonly AgentRole[];
	readonly issues: readonly AgentRoleDiagnosticIssue[];
}

export interface DiscoverAgentRolesOptions {
	readonly homeDir: string;
	readonly workspaceRoot: string;
	/** Repository roles are read only when the workspace is trusted for project configuration. */
	readonly includeRepository?: boolean;
}

const ROLE_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const ROLE_FIELDS = new Set(["name", "description", "model", "tools"]);
const DESCRIPTION_MAX_CHARS = 512;
const MAX_ROLES = 64;
const MAX_ROLE_TOOLS = 128;

/**
 * Reads the roles a project declares, as `<dir>/.mycli/agents/<name>.toml`.
 *
 * A role is deliberately narrow: a description the model reads, an optional model override, and an
 * optional tool allowlist. It cannot grant authority — the caller's tool scope and permissions are
 * intersected with it, never widened — so a role file is a convenience, not a privilege boundary.
 */
export async function discoverAgentRoles(options: DiscoverAgentRolesOptions): Promise<AgentRoleCatalog> {
	const directories: readonly { readonly root: string; readonly sourceKind: AgentRoleSourceKind }[] = [
		{ root: join(options.homeDir, ".mycli", "agents"), sourceKind: "user" },
		...(options.includeRepository === false
			? []
			: [{ root: join(options.workspaceRoot, ".mycli", "agents"), sourceKind: "repo" as const }]),
	];
	const byName = new Map<string, AgentRole>();
	const issues: AgentRoleDiagnosticIssue[] = [];
	for (const directory of directories) {
		let entries: readonly string[];
		try {
			entries = (await readdir(directory.root)).filter((entry) => entry.endsWith(".toml")).sort();
		} catch {
			// A missing directory is the ordinary case: most projects declare no roles.
			continue;
		}
		for (const entry of entries) {
			const path = join(directory.root, entry);
			const role = await readRole(path, entry, directory.sourceKind, issues);
			if (role) byName.set(role.name, role);
		}
	}
	return Object.freeze({
		roles: Object.freeze([...byName.values()].slice(0, MAX_ROLES)),
		issues: Object.freeze(issues),
	});
}

export function agentRoleByName(catalog: AgentRoleCatalog, name: string): AgentRole | undefined {
	return catalog.roles.find((role) => role.name === name);
}

/**
 * Narrows the tools a role may use. The allowlist is intersected with what the caller may already
 * delegate, so declaring a tool the caller cannot use grants nothing — a role file is a convenience,
 * not a privilege boundary. The model override is applied where the child's provider is resolved,
 * because changing the model without re-resolving the provider would pair the two wrongly.
 */
export function applyAgentRole(
	role: AgentRole | undefined,
	tools: readonly string[],
): readonly string[] {
	if (role?.tools === undefined) return Object.freeze([...tools]);
	const allowed = new Set(role.tools);
	return Object.freeze(tools.filter((tool) => allowed.has(tool)));
}

async function readRole(
	path: string,
	fileLabel: string,
	sourceKind: AgentRoleSourceKind,
	issues: AgentRoleDiagnosticIssue[],
): Promise<AgentRole | undefined> {
	const reject = (errorClass: string): undefined => {
		issues.push(Object.freeze({ sourceKind, fileLabel, errorClass }));
		return undefined;
	};
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return reject("file_read_failed");
	}
	let parsed: unknown;
	try {
		parsed = parseToml(raw);
	} catch {
		return reject("toml_invalid");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return reject("role_invalid");
	const record = parsed as Readonly<Record<string, unknown>>;
	if (Object.keys(record).some((key) => !ROLE_FIELDS.has(key))) return reject("role_unknown_field");
	const name = record.name;
	const description = record.description;
	if (typeof name !== "string" || !ROLE_NAME.test(name)) return reject("role_name_invalid");
	if (typeof description !== "string" || !description.trim() || description.length > DESCRIPTION_MAX_CHARS) {
		return reject("role_description_invalid");
	}
	const model = record.model;
	if (model !== undefined && (typeof model !== "string" || !model.trim())) return reject("role_model_invalid");
	const tools = record.tools;
	if (tools !== undefined && (!Array.isArray(tools) || tools.length > MAX_ROLE_TOOLS
		|| tools.some((tool) => typeof tool !== "string" || !tool.trim()))) {
		return reject("role_tools_invalid");
	}
	return Object.freeze({
		name,
		description: description.trim(),
		sourcePath: path,
		sourceKind,
		...(model === undefined ? {} : { model: (model as string).trim() }),
		...(tools === undefined ? {} : { tools: Object.freeze((tools as readonly string[]).map((tool) => tool.trim())) }),
	});
}
