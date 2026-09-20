import { isIP } from "node:net";

export type NetworkRuleProtocol = "any" | "tcp" | "udp" | "icmpv4" | "icmpv6";

export interface NetworkPortRule {
	readonly protocol?: NetworkRuleProtocol;
	readonly port?: number;
	readonly endPort?: number;
}

export interface NetworkDestination {
	readonly cidr: string;
	readonly except?: readonly string[];
}

export interface NetworkEgressRule {
	readonly to: readonly NetworkDestination[];
	readonly ports?: readonly NetworkPortRule[];
}

export interface NetworkEgressPolicy {
	readonly default: "allow" | "deny";
	readonly allow?: readonly NetworkEgressRule[];
	readonly deny?: readonly NetworkEgressRule[];
}

export const NETWORK_EGRESS_LIMITS = Object.freeze({
	rules: 32,
	destinations: 8,
	except: 8,
	ports: 8,
});

/**
 * Validates and freezes a structured egress policy. Host loopback is authorized
 * only by an explicit rule, so a structured policy is always a deny-by-default
 * allowlist; "allow everything" stays the plain enabled-network profile. Rich
 * rules are enforced by the PSEC backend; the legacy backend fails closed.
 */
export function freezeNetworkEgress(value: NetworkEgressPolicy): NetworkEgressPolicy {
	if (!isRecord(value) || value.default !== "deny") {
		throw new TypeError("network egress requires a deny default");
	}
	const allow = freezeRuleList(value.allow, "allow");
	const deny = freezeRuleList(value.deny, "deny");
	return Object.freeze({
		default: value.default,
		...(allow === undefined ? {} : { allow }),
		...(deny === undefined ? {} : { deny }),
	});
}

function freezeRuleList(
	value: readonly NetworkEgressRule[] | undefined,
	label: "allow" | "deny",
): readonly NetworkEgressRule[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0
		|| value.length > NETWORK_EGRESS_LIMITS.rules) {
		throw new TypeError(`network egress ${label} rules must be a bounded non-empty list`);
	}
	return Object.freeze(value.map((rule, index) => freezeRule(rule, `${label} rule ${index}`)));
}

function freezeRule(value: NetworkEgressRule, label: string): NetworkEgressRule {
	if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
	const to = value.to;
	if (!Array.isArray(to) || to.length === 0 || to.length > NETWORK_EGRESS_LIMITS.destinations) {
		throw new TypeError(`${label} requires between 1 and ${NETWORK_EGRESS_LIMITS.destinations} destinations`);
	}
	const destinations = Object.freeze(to.map((destination, index) =>
		freezeDestination(destination, `${label} destination ${index}`)));
	const ports = value.ports === undefined ? undefined : freezePorts(value.ports, `${label} ports`);
	return Object.freeze({
		to: destinations,
		...(ports === undefined ? {} : { ports }),
	});
}

function freezeDestination(value: NetworkDestination, label: string): NetworkDestination {
	if (!isRecord(value) || typeof value.cidr !== "string" || !isCidr(value.cidr)) {
		throw new TypeError(`${label} requires a valid CIDR`);
	}
	const except = value.except;
	if (except === undefined) return Object.freeze({ cidr: value.cidr });
	if (!Array.isArray(except) || except.length === 0 || except.length > NETWORK_EGRESS_LIMITS.except
		|| except.some((entry) => typeof entry !== "string" || !isCidr(entry))) {
		throw new TypeError(`${label} exceptions must be bounded valid CIDRs`);
	}
	return Object.freeze({ cidr: value.cidr, except: Object.freeze([...except]) });
}

function freezePorts(
	value: readonly NetworkPortRule[],
	label: string,
): readonly NetworkPortRule[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > NETWORK_EGRESS_LIMITS.ports) {
		throw new TypeError(`${label} must be a bounded non-empty list`);
	}
	return Object.freeze(value.map((entry, index) => {
		if (!isRecord(entry)) throw new TypeError(`${label} entry ${index} must be an object`);
		const protocol = entry.protocol;
		if (protocol !== undefined && !isNetworkProtocol(protocol)) {
			throw new TypeError(`${label} entry ${index} has an invalid protocol`);
		}
		const port = optionalPort(entry.port, `${label} entry ${index} port`);
		const endPort = optionalPort(entry.endPort, `${label} entry ${index} endPort`);
		if (port === undefined && endPort !== undefined) {
			throw new TypeError(`${label} entry ${index} endPort requires a port`);
		}
		if (port !== undefined && endPort !== undefined && endPort < port) {
			throw new TypeError(`${label} entry ${index} has an inverted port range`);
		}
		return Object.freeze({
			...(protocol === undefined ? {} : { protocol }),
			...(port === undefined ? {} : { port }),
			...(endPort === undefined ? {} : { endPort }),
		});
	}));
}

function optionalPort(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65_535) {
		throw new TypeError(`${label} must be an integer between 0 and 65535`);
	}
	return value;
}

function isNetworkProtocol(value: unknown): value is NetworkRuleProtocol {
	return value === "any" || value === "tcp" || value === "udp"
		|| value === "icmpv4" || value === "icmpv6";
}

function isCidr(value: string): boolean {
	const separator = value.indexOf("/");
	if (separator <= 0 || value.indexOf("/", separator + 1) !== -1) return false;
	const address = value.slice(0, separator);
	const prefix = value.slice(separator + 1);
	const family = isIP(address);
	if (family === 0 || !/^(?:0|[1-9][0-9]{0,2})$/u.test(prefix)) return false;
	const length = Number(prefix);
	return family === 4 ? length <= 32 : length <= 128;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
