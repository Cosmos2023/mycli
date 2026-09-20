import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	freezeNetworkEgress,
	normalizeNetworkDomains,
	type NetworkEgressPolicy,
} from "@mycli/core";
import { parse } from "smol-toml";

const EXECUTION_POLICY_FIELDS = new Set([
	"network",
	"readable_roots",
	"readonly_roots",
	"allow_local_binding",
	"writable_tmp",
	"denied_read_roots",
	"denied_read_globs",
	"writable_roots",
	"allowed_network_domains",
	"network_egress",
]);

export interface ManagedExecutionPolicyConstraints {
	readonly source: "managed";
	readonly network?: "enabled" | "disabled";
	readonly networkDomains?: readonly string[];
	readonly networkEgress?: NetworkEgressPolicy;
	readonly readableRoots?: readonly string[];
	readonly readOnlyRoots?: readonly string[];
	readonly allowLocalBinding?: boolean;
	readonly writableTemp?: boolean;
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
	const readOnlyRoots = optionalStringArray(policy.readonly_roots, "readonly_roots", 256, 4_096);
	if (readOnlyRoots?.some((root) => !isAbsolute(root))) throw invalidManagedPolicy("readonly_roots");
	const allowLocalBinding = optionalBoolean(policy.allow_local_binding, "allow_local_binding");
	const writableTemp = optionalBoolean(policy.writable_tmp, "writable_tmp");
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
	const networkEgress = managedNetworkEgress(policy.network_egress);
	if (networkEgress !== undefined && (networkDomains !== undefined || network === "disabled")) {
		throw invalidManagedPolicy("network_egress");
	}
	if (network === undefined
		&& deniedReadRoots === undefined
		&& deniedReadGlobs === undefined
		&& readableRoots === undefined
		&& readOnlyRoots === undefined && allowLocalBinding === undefined && writableTemp === undefined
		&& writableRoots === undefined
		&& networkDomains === undefined
		&& networkEgress === undefined) {
		return undefined;
	}
	return Object.freeze({
		source: "managed" as const,
		...(deniedReadRoots === undefined ? {} : { deniedReadRoots }),
		...(deniedReadGlobs === undefined ? {} : { deniedReadGlobs }),
		...(network === undefined ? {} : { network }),
		...(readableRoots === undefined ? {} : { readableRoots }),
		...(readOnlyRoots === undefined ? {} : { readOnlyRoots }),
		...(allowLocalBinding === undefined ? {} : { allowLocalBinding }),
		...(writableTemp === undefined ? {} : { writableTemp }),
		...(writableRoots === undefined ? {} : { writableRoots }),
		...(networkDomains === undefined ? {} : { networkDomains }),
		...(networkEgress === undefined ? {} : { networkEgress }),
	});
}

function managedNetworkEgress(value: unknown): NetworkEgressPolicy | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw invalidManagedPolicy("network_egress");
	try {
		return freezeNetworkEgress({
			default: value.default as NetworkEgressPolicy["default"],
			...(value.allow === undefined ? {} : { allow: managedEgressRules(value.allow) }),
			...(value.deny === undefined ? {} : { deny: managedEgressRules(value.deny) }),
		});
	} catch {
		throw invalidManagedPolicy("network_egress");
	}
}

function managedEgressRules(value: unknown) {
	if (!Array.isArray(value)) throw invalidManagedPolicy("network_egress");
	return value.map((rule) => {
		if (!isRecord(rule) || !Array.isArray(rule.to)) throw invalidManagedPolicy("network_egress");
		const to = rule.to.map((destination) => {
			if (!isRecord(destination) || typeof destination.cidr !== "string") {
				throw invalidManagedPolicy("network_egress");
			}
			const except = destination.except;
			if (except !== undefined && !Array.isArray(except)) throw invalidManagedPolicy("network_egress");
			return {
				cidr: destination.cidr,
				...(except === undefined ? {} : { except: except as readonly string[] }),
			};
		});
		const ports = rule.ports;
		if (ports === undefined) return { to };
		if (!Array.isArray(ports)) throw invalidManagedPolicy("network_egress");
		return {
			to,
			ports: ports.map((port) => {
				if (!isRecord(port)) throw invalidManagedPolicy("network_egress");
				const endPort = port.end_port;
				if (endPort !== undefined && typeof endPort !== "number") {
					throw invalidManagedPolicy("network_egress");
				}
				return {
					...(port.protocol === undefined ? {} : { protocol: port.protocol }),
					...(port.port === undefined ? {} : { port: port.port }),
					...(endPort === undefined ? {} : { endPort }),
				} as never;
			}),
		};
	});
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined || typeof value === "boolean") return value;
	throw invalidManagedPolicy(field);
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
