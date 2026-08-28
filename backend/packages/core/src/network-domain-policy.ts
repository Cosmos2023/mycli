import { isIP } from "node:net";

export function normalizeNetworkDomains(domains: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(domains.map(normalizeNetworkDomainPattern))]);
}

export function networkDomainAllowed(
	hostname: string,
	domains: readonly string[] | undefined,
): boolean {
	if (domains === undefined) return true;
	const host = normalizeNetworkHostname(hostname);
	return domains.some((pattern) => {
		const normalized = normalizeNetworkDomainPattern(pattern);
		return normalized.startsWith("*.")
			? host.length > normalized.length - 1 && host.endsWith(normalized.slice(1))
			: host === normalized;
	});
}

function normalizeNetworkDomainPattern(value: string): string {
	if (typeof value !== "string") throw new TypeError("network domain must be a string");
	const normalized = value.trim().toLowerCase().replace(/\.$/u, "");
	const host = normalized.startsWith("*.") ? normalized.slice(2) : normalized;
	if (!host || host.length > 253 || host.includes(":")) {
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
	if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
	return hostname;
}
