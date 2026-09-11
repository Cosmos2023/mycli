import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type PublicTargetLookup = (hostname: string) => Promise<readonly LookupAddress[]>;

const BLOCKED_HOST_SUFFIXES = Object.freeze([
	".home",
	".internal",
	".lan",
	".local",
	".localhost",
]);
export async function resolvePublicTarget(
	url: URL,
	lookup: PublicTargetLookup = lookupAll,
	signal?: AbortSignal,
): Promise<LookupAddress> {
	const hostname = normalizedHostname(url.hostname);
	const literalFamily = isIP(hostname);
	const addresses = literalFamily === 0
		? await raceAbort(lookup(hostname), signal)
		: [{ address: hostname, family: literalFamily }];
	if (addresses.length === 0) {
		throw new PublicTargetError("dns_failed", "Hostname did not resolve to an address.");
	}
	if (addresses.some((address) => !isPublicIpAddress(address.address))) {
		throw new PublicTargetError("unsafe_address", "URL resolves to a non-public address.");
	}
	const selected = addresses[0];
	if (!selected || (selected.family !== 4 && selected.family !== 6)) {
		throw new PublicTargetError("dns_failed", "Hostname resolved to an unsupported address.");
	}
	return Object.freeze({ address: selected.address, family: selected.family });
}

export function normalizePublicUrl(value: unknown): URL {
	if (typeof value !== "string") throw new PublicTargetError("invalid_url", "URL must be a string.");
	const raw = value.trim();
	if (!raw || raw.length > 4_096) throw new PublicTargetError("invalid_url", "URL is invalid.");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new PublicTargetError("invalid_url", "URL is invalid.");
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
		throw new PublicTargetError("invalid_url", "Only HTTP(S) URLs are supported.");
	}
	if (url.username || url.password) {
		throw new PublicTargetError("invalid_url", "Credentialed URLs are not supported.");
	}
	const hostname = normalizedHostname(url.hostname);
	const lower = hostname.toLowerCase();
	if (lower === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
		throw new PublicTargetError("unsafe_address", "Local hostnames are not allowed.");
	}
	if (isIP(hostname) !== 0 && !isPublicIpAddress(hostname)) {
		throw new PublicTargetError("unsafe_address", "URL address is not public.");
	}
	url.hash = "";
	return url;
}

export function isPublicIpAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) {
		const value = ipv4Value(address);
		return value !== undefined && !BLOCKED_IPV4.some(([base, prefix]) => inPrefix(value, base, prefix, 32));
	}
	if (family !== 6 || address.includes("%")) return false;
	const value = ipv6Value(address);
	if (value === undefined) return false;
	const mappedPrefix = 0xffffn;
	if ((value >> 32n) === mappedPrefix) {
		return !BLOCKED_IPV4.some(([base, prefix]) => inPrefix(Number(value & 0xffff_ffffn), base, prefix, 32));
	}
	if (!inPrefix(value, PUBLIC_IPV6_BASE, 3, 128)) return false;
	return !BLOCKED_IPV6.some(([base, prefix]) => inPrefix(value, base, prefix, 128));
}

const PUBLIC_IPV6_BASE = ipv6("2000::");

const BLOCKED_IPV4: readonly (readonly [number, number])[] = Object.freeze([
	[ipv4("0.0.0.0"), 8],
	[ipv4("10.0.0.0"), 8],
	[ipv4("100.64.0.0"), 10],
	[ipv4("127.0.0.0"), 8],
	[ipv4("169.254.0.0"), 16],
	[ipv4("172.16.0.0"), 12],
	[ipv4("192.0.0.0"), 24],
	[ipv4("192.0.2.0"), 24],
	[ipv4("192.88.99.0"), 24],
	[ipv4("192.168.0.0"), 16],
	[ipv4("198.18.0.0"), 15],
	[ipv4("198.51.100.0"), 24],
	[ipv4("203.0.113.0"), 24],
	[ipv4("224.0.0.0"), 4],
	[ipv4("240.0.0.0"), 4],
]);

const BLOCKED_IPV6: readonly (readonly [bigint, number])[] = Object.freeze([
	[ipv6("::"), 128],
	[ipv6("::1"), 128],
	[ipv6("64:ff9b::"), 96],
	[ipv6("64:ff9b:1::"), 48],
	[ipv6("100::"), 64],
	[ipv6("2001::"), 32],
	[ipv6("2001:2::"), 48],
	[ipv6("2001:10::"), 28],
	[ipv6("2001:20::"), 28],
	[ipv6("2001:db8::"), 32],
	[ipv6("2002::"), 16],
	[ipv6("fc00::"), 7],
	[ipv6("fe80::"), 10],
	[ipv6("fec0::"), 10],
	[ipv6("ff00::"), 8],
]);

export class PublicTargetError extends Error {
	readonly kind: string;

	constructor(kind: string, message: string) {
		super(message);
		this.name = "PublicTargetError";
		this.kind = kind;
	}
}

async function lookupAll(hostname: string): Promise<readonly LookupAddress[]> {
	try {
		return await dnsLookup(hostname, { all: true, order: "verbatim" });
	} catch {
		throw new PublicTargetError("dns_failed", "Hostname resolution failed.");
	}
}

function normalizedHostname(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function ipv4(address: string): number {
	const value = ipv4Value(address);
	if (value === undefined) throw new TypeError("invalid static IPv4 range");
	return value;
}

function ipv4Value(address: string): number | undefined {
	const parts = address.split(".");
	if (parts.length !== 4) return undefined;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/u.test(part)) return undefined;
		const octet = Number(part);
		if (octet > 255) return undefined;
		value = value * 256 + octet;
	}
	return value;
}

function ipv6(address: string): bigint {
	const value = ipv6Value(address);
	if (value === undefined) throw new TypeError("invalid static IPv6 range");
	return value;
}

function ipv6Value(address: string): bigint | undefined {
	let normalized = address.toLowerCase();
	if (normalized.includes("%")) return undefined;
	const dottedIndex = normalized.lastIndexOf(":");
	if (normalized.includes(".") && dottedIndex >= 0) {
		const tail = ipv4Value(normalized.slice(dottedIndex + 1));
		if (tail === undefined) return undefined;
		normalized = `${normalized.slice(0, dottedIndex)}:${(tail >>> 16).toString(16)}:${(tail & 0xffff).toString(16)}`;
	}
	const halves = normalized.split("::");
	if (halves.length > 2) return undefined;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
	if (halves.length === 1 ? left.length !== 8 : fill < 1) return undefined;
	const groups = [...left, ...Array.from({ length: fill }, () => "0"), ...right];
	if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return undefined;
	return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function inPrefix<Value extends number | bigint>(
	value: Value,
	base: Value,
	prefix: number,
	bits: number,
): boolean {
	if (typeof value === "bigint" && typeof base === "bigint") {
		const shift = BigInt(bits - prefix);
		return (value >> shift) === (base >> shift);
	}
	if (typeof value === "number" && typeof base === "number") {
		const divisor = 2 ** (bits - prefix);
		return Math.floor(value / divisor) === Math.floor(base / divisor);
	}
	return false;
}

async function raceAbort<Value>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> {
	if (!signal) return promise;
	assertNotAborted(signal);
	return new Promise((resolve, reject) => {
		const onAbort = (): void => { reject(abortReason(signal)); };
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortReason(signal);
}

export function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
}
