import { isIP } from "node:net";

export function normalizeNetworkDomains(domains: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(domains.map(normalizeNetworkDomainPattern))]);
}

export function intersectNetworkDomains(
	left: readonly string[] | undefined,
	right: readonly string[] | undefined,
): readonly string[] | undefined {
	if (left === undefined) return right === undefined ? undefined : normalizeNetworkDomains(right);
	if (right === undefined) return normalizeNetworkDomains(left);
	const current = normalizeNetworkDomains(left);
	const ceiling = normalizeNetworkDomains(right);
	// Exact/suffix patterns intersect at the narrower pattern, including nested wildcards.
	return normalizeNetworkDomains([
		...current.filter((pattern) => ceiling.some((bound) => domainPatternContains(bound, pattern))),
		...ceiling.filter((pattern) => current.some((bound) => domainPatternContains(bound, pattern))),
	]);
}

export function networkDomainAllowed(
	hostname: string,
	domains: readonly string[] | undefined,
): boolean {
	if (domains === undefined) return true;
	const host = normalizeNetworkHostname(hostname);
	return domains.some((pattern) => domainPatternContains(normalizeNetworkDomainPattern(pattern), host));
}

function domainPatternContains(ceiling: string, candidate: string): boolean {
	return ceiling.startsWith("*.")
		? candidate.length > ceiling.length - 1 && candidate.endsWith(ceiling.slice(1))
		: candidate === ceiling;
}

function normalizeNetworkDomainPattern(value: string): string {
	if (typeof value !== "string") throw new TypeError("network domain must be a string");
	const normalized = value.trim().toLowerCase().replace(/\.$/u, "");
	const host = normalizeNetworkHostname(normalized.startsWith("*.") ? normalized.slice(2) : normalized);
	if (!host || host.length > 253 || (host.includes(":") && isIP(host) !== 6)) {
		throw new TypeError("network domain is invalid");
	}
	if (isIP(host) === 0 && !host.split(".").every((label) => (
		label.length > 0
		&& label.length <= 63
		&& /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
	))) {
		throw new TypeError("network domain is invalid");
	}
	if (normalized.startsWith("*.") && isIP(host) !== 0) {
		throw new TypeError("network domain wildcard is invalid");
	}
	return normalized.startsWith("*.") ? `*.${host}` : host;
}

function normalizeNetworkHostname(value: string): string {
	const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
	const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	return isIP(unbracketed) === 6 ? new URL(`http://[${unbracketed}]`).hostname.slice(1, -1) : hostname;
}
