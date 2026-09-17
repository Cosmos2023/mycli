import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { normalizeNetworkDomains } from "@mycli/core";
import { parse } from "smol-toml";

const EXECUTION_POLICY_FIELDS = new Set([
	"network",
	"readable_roots",
	"denied_read_roots",
	"denied_read_globs",
	"writable_roots",
	"allowed_network_domains",
]);

export interface ManagedExecutionPolicyConstraints {
	readonly source: "managed";
	readonly network?: "enabled" | "disabled";
	readonly networkDomains?: readonly string[];
	readonly readableRoots?: readonly string[];
	readonly deniedReadRoots?: readonly string[];
	readonly deniedReadGlobs?: readonly string[];
	readonly writableRoots?: readonly string[];
}

export interface LoadManagedExecutionPolicyOptions {
	readonly homeDir: string;
	readonly configPath?: string;
}

export async function loadManagedExecutionPolicy(
	options: LoadManagedExecutionPolicyOptions,
): Promise<ManagedExecutionPolicyConstraints | undefined> {
	const path = options.configPath ?? join(options.homeDir, ".mycli", "managed_config.toml");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw new Error("config_error: could not read managed config");
	}
	let parsed: unknown;
	try {
		parsed = parse(raw);
	} catch {
		throw new Error("config_error: invalid TOML in managed config");
	}
	if (!isRecord(parsed)) throw invalidManagedPolicy();
	const policy = parsed.execution_policy;
	if (policy === undefined) return undefined;
	if (!isRecord(policy)) throw invalidManagedPolicy();
	for (const field of Object.keys(policy)) {
		if (!EXECUTION_POLICY_FIELDS.has(field)) throw invalidManagedPolicy(field);
	}
	const network = optionalNetworkPolicy(policy.network);
	const deniedReadRoots = optionalStringArray(policy.denied_read_roots, "denied_read_roots", 256, 4_096);
	const deniedReadGlobs = optionalStringArray(policy.denied_read_globs, "denied_read_globs", 256, 4_096);
	if (deniedReadRoots?.some((root) => !isAbsolute(root))) throw invalidManagedPolicy("denied_read_roots");
	if (deniedReadGlobs?.some((glob) => isAbsolute(glob) || glob.includes("\\") || glob.split("/").includes(".."))) {
		throw invalidManagedPolicy("denied_read_globs");
	}
	const readableRoots = optionalStringArray(policy.readable_roots, "readable_roots", 256, 4_096);
	const writableRoots = optionalStringArray(policy.writable_roots, "writable_roots", 256, 4_096);
	const configuredNetworkDomains = optionalStringArray(
		policy.allowed_network_domains,
		"allowed_network_domains",
		256,
		253,
	);
	let networkDomains: readonly string[] | undefined;
	try {
		networkDomains = configuredNetworkDomains === undefined
			? undefined
			: normalizeNetworkDomains(configuredNetworkDomains);
	} catch {
		throw invalidManagedPolicy("allowed_network_domains");
	}
	if (network === undefined
		&& deniedReadRoots === undefined
		&& deniedReadGlobs === undefined
		&& readableRoots === undefined
		&& writableRoots === undefined
		&& networkDomains === undefined) {
		return undefined;
	}
	return Object.freeze({
		source: "managed" as const,
		...(deniedReadRoots === undefined ? {} : { deniedReadRoots }),
		...(deniedReadGlobs === undefined ? {} : { deniedReadGlobs }),
		...(network === undefined ? {} : { network }),
		...(readableRoots === undefined ? {} : { readableRoots }),
		...(writableRoots === undefined ? {} : { writableRoots }),
		...(networkDomains === undefined ? {} : { networkDomains }),
	});
}

function optionalNetworkPolicy(value: unknown): "enabled" | "disabled" | undefined {
	if (value === undefined) return undefined;
	if (value === "enabled" || value === "disabled") return value;
	throw invalidManagedPolicy("network");
}

function optionalStringArray(
	value: unknown,
	field: string,
	maximumItems: number,
	maximumChars: number,
): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > maximumItems) throw invalidManagedPolicy(field);
	const result = value.map((item) => {
		if (typeof item !== "string"
			|| !item.trim()
			|| item.length > maximumChars
			|| /[\0\r\n]/u.test(item)) {
			throw invalidManagedPolicy(field);
		}
		return item.trim();
	});
	return Object.freeze([...new Set(result)]);
}

function invalidManagedPolicy(field?: string): Error {
	return new Error(`config_error: invalid managed execution policy${field ? ` field '${field}'` : ""}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
