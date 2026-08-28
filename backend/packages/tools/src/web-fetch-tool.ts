import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { TOOL_RESULT_OUTPUT_MAX_CHARS } from "@mycli/core";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { WEB_FETCH_TOOL_DEFINITION } from "./manifest.ts";
import { networkDomainAllowed } from "./execution-policy.ts";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const EXTERNAL_START = "<<<EXTERNAL_WEB_CONTENT_UNTRUSTED>>>";
const EXTERNAL_END = "<<<END_EXTERNAL_WEB_CONTENT_UNTRUSTED>>>";
const BLOCKED_HOST_SUFFIXES = Object.freeze([
	".home",
	".internal",
	".lan",
	".local",
	".localhost",
]);
const BLOCK_ELEMENTS = new Set([
	"address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption",
	"figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main",
	"nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
const OMITTED_ELEMENTS = new Set([
	"canvas", "iframe", "noscript", "object", "script", "style", "svg", "template",
]);

export interface WebFetchResponse {
	readonly statusCode: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Uint8Array;
}

export interface PublicWebFetcher {
	fetch(url: URL, signal: AbortSignal): Promise<WebFetchResponse>;
}

export interface WebFetchToolOptions {
	readonly fetcher?: PublicWebFetcher;
	readonly timeoutMs?: number;
	readonly maxRedirects?: number;
	readonly maxResponseBytes?: number;
}

export type WebFetchLookup = (hostname: string) => Promise<readonly LookupAddress[]>;

export class WebFetchTool implements ToolAdapter {
	readonly definition = WEB_FETCH_TOOL_DEFINITION;
	readonly supportsParallelToolCalls = true;
	readonly #fetcher: PublicWebFetcher;
	readonly #timeoutMs: number;
	readonly #maxRedirects: number;
	readonly #maxResponseBytes: number;

	constructor(options: WebFetchToolOptions = {}) {
		this.#timeoutMs = boundedPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 120_000);
		this.#maxRedirects = boundedPositiveInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 10);
		const maxResponseBytes = boundedPositiveInteger(
			options.maxResponseBytes,
			DEFAULT_MAX_RESPONSE_BYTES,
			16_777_216,
		);
		this.#maxResponseBytes = maxResponseBytes;
		this.#fetcher = options.fetcher ?? new PinnedPublicWebFetcher({ maxResponseBytes });
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		if (options.executionPolicy?.network !== "enabled") {
			return failure("network_disabled", "Network access is disabled by the active execution policy.");
		}
		let url: URL;
		try {
			url = normalizePublicUrl(argumentsValue.url);
		} catch (error) {
			return failureFrom(error, "invalid_url");
		}
		const networkDomains = options.executionPolicy.networkDomains;
		if (!networkDomainAllowed(url.hostname, networkDomains)) {
			return failure("network_domain_denied", "The target domain is not allowed by the active execution policy.");
		}
		const controller = new AbortController();
		let timedOut = false;
		const onAbort = (): void => { controller.abort(options.signal.reason); };
		options.signal.addEventListener("abort", onAbort, { once: true });
		if (options.signal.aborted) controller.abort(options.signal.reason);
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new DOMException("web fetch timed out", "AbortError"));
		}, this.#timeoutMs);
		try {
			const fetched = await this.#followRedirects(url, controller.signal, networkDomains);
			const content = projectContent(fetched.response, fetched.url);
			return {
				success: true,
				modelOutput: externalOutput(fetched.url, content),
				summary: `Fetched ${displayHost(fetched.url)}`,
				metadata: Object.freeze({
					status_code: fetched.response.statusCode,
					content_type: mediaType(fetched.response.headers["content-type"]),
					response_bytes: fetched.response.body.byteLength,
					redirect_count: fetched.redirectCount,
					external_context: true,
				}),
			};
		} catch (error) {
			if (options.signal.aborted) throw abortReason(options.signal);
			if (timedOut) return failure("fetch_timeout", "Web fetch exceeded its time limit.");
			return failureFrom(error, "network_error");
		} finally {
			clearTimeout(timer);
			options.signal.removeEventListener("abort", onAbort);
		}
	}

	async #followRedirects(
		initialUrl: URL,
		signal: AbortSignal,
		networkDomains: readonly string[] | undefined,
	): Promise<{ url: URL; response: WebFetchResponse; redirectCount: number }> {
		let url = initialUrl;
		for (let redirects = 0; ; redirects += 1) {
			const response = await this.#fetcher.fetch(url, signal);
			if (response.body.byteLength > this.#maxResponseBytes) {
				throw new WebFetchFailure("response_too_large", "Response exceeds the byte limit.");
			}
			if (!isRedirect(response.statusCode)) {
				if (response.statusCode < 200 || response.statusCode >= 300) {
					throw new WebFetchFailure("http_error", `Remote server returned HTTP ${response.statusCode}.`);
				}
				return { url, response, redirectCount: redirects };
			}
			if (redirects >= this.#maxRedirects) {
				throw new WebFetchFailure("too_many_redirects", "Web fetch exceeded its redirect limit.");
			}
			const location = response.headers.location;
			if (!location) throw new WebFetchFailure("invalid_redirect", "Redirect response has no location.");
			try {
				url = normalizePublicUrl(new URL(location, url).toString());
			} catch (error) {
				if (error instanceof WebFetchFailure && error.kind === "unsafe_address") {
					throw new WebFetchFailure("unsafe_redirect", "Redirect target is not public.");
				}
				throw new WebFetchFailure("invalid_redirect", "Redirect target is invalid.");
			}
			if (!networkDomainAllowed(url.hostname, networkDomains)) {
				throw new WebFetchFailure(
					"network_domain_denied",
					"Redirect target is not allowed by the active execution policy.",
				);
			}
		}
	}
}

export interface PinnedPublicWebFetcherOptions {
	readonly maxResponseBytes?: number;
	readonly lookup?: WebFetchLookup;
}

export class PinnedPublicWebFetcher implements PublicWebFetcher {
	readonly #maxResponseBytes: number;
	readonly #lookup: WebFetchLookup;

	constructor(options: PinnedPublicWebFetcherOptions = {}) {
		this.#maxResponseBytes = boundedPositiveInteger(
			options.maxResponseBytes,
			DEFAULT_MAX_RESPONSE_BYTES,
			16_777_216,
		);
		this.#lookup = options.lookup ?? lookupAll;
	}

	async fetch(url: URL, signal: AbortSignal): Promise<WebFetchResponse> {
		assertNotAborted(signal);
		const target = await resolvePublicTarget(url, this.#lookup, signal);
		assertNotAborted(signal);
		return requestPinned(url, target, signal, this.#maxResponseBytes);
	}
}

export async function resolvePublicTarget(
	url: URL,
	lookup: WebFetchLookup = lookupAll,
	signal?: AbortSignal,
): Promise<LookupAddress> {
	const hostname = normalizedHostname(url.hostname);
	const literalFamily = isIP(hostname);
	const addresses = literalFamily === 0
		? await raceAbort(lookup(hostname), signal)
		: [{ address: hostname, family: literalFamily }];
	if (addresses.length === 0) {
		throw new WebFetchFailure("dns_failed", "Hostname did not resolve to an address.");
	}
	if (addresses.some((address) => !isPublicIpAddress(address.address))) {
		throw new WebFetchFailure("unsafe_address", "URL resolves to a non-public address.");
	}
	const selected = addresses[0];
	if (!selected || (selected.family !== 4 && selected.family !== 6)) {
		throw new WebFetchFailure("dns_failed", "Hostname resolved to an unsupported address.");
	}
	return Object.freeze({ address: selected.address, family: selected.family });
}

export function normalizePublicUrl(value: unknown): URL {
	if (typeof value !== "string") throw new WebFetchFailure("invalid_url", "URL must be a string.");
	const raw = value.trim();
	if (!raw || raw.length > 4_096) throw new WebFetchFailure("invalid_url", "URL is invalid.");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new WebFetchFailure("invalid_url", "URL is invalid.");
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
		throw new WebFetchFailure("invalid_url", "Only HTTP(S) URLs are supported.");
	}
	if (url.username || url.password) {
		throw new WebFetchFailure("invalid_url", "Credentialed URLs are not supported.");
	}
	const hostname = normalizedHostname(url.hostname);
	const lower = hostname.toLowerCase();
	if (lower === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
		throw new WebFetchFailure("unsafe_address", "Local hostnames are not allowed.");
	}
	if (isIP(hostname) !== 0 && !isPublicIpAddress(hostname)) {
		throw new WebFetchFailure("unsafe_address", "URL address is not public.");
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

class WebFetchFailure extends Error {
	readonly kind: string;

	constructor(kind: string, message: string) {
		super(message);
		this.name = "WebFetchFailure";
		this.kind = kind;
	}
}

async function lookupAll(hostname: string): Promise<readonly LookupAddress[]> {
	try {
		return await dnsLookup(hostname, { all: true, order: "verbatim" });
	} catch {
		throw new WebFetchFailure("dns_failed", "Hostname resolution failed.");
	}
}

function requestPinned(
	url: URL,
	target: LookupAddress,
	signal: AbortSignal,
	maxResponseBytes: number,
): Promise<WebFetchResponse> {
	return new Promise((resolve, reject) => {
		const requestFn = url.protocol === "https:" ? https.request : http.request;
		const request = requestFn(url, {
			method: "GET",
			headers: {
				accept: "text/html, application/json, text/plain;q=0.9, text/*;q=0.8",
				"accept-encoding": "identity",
				"user-agent": "mycli-node/0.1 web_fetch",
			},
			lookup: pinnedLookup(target),
			signal,
		}, (response) => {
			const declaredLength = positiveHeaderInteger(response.headers["content-length"]);
			if (declaredLength !== undefined && declaredLength > maxResponseBytes) {
				response.destroy();
				reject(new WebFetchFailure("response_too_large", "Response exceeds the byte limit."));
				return;
			}
			const chunks: Buffer[] = [];
			let received = 0;
			response.on("data", (chunk: Buffer | string) => {
				const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
				received += buffer.byteLength;
				if (received > maxResponseBytes) {
					response.destroy(new WebFetchFailure("response_too_large", "Response exceeds the byte limit."));
					return;
				}
				chunks.push(buffer);
			});
			response.once("error", reject);
			response.once("end", () => {
				resolve(Object.freeze({
					statusCode: response.statusCode ?? 0,
					headers: normalizedHeaders(response.headers),
					body: Buffer.concat(chunks, received),
				}));
			});
		});
		request.once("error", (error) => {
			reject(error instanceof WebFetchFailure
				? error
				: new WebFetchFailure("network_error", "Network request failed."));
		});
		request.end();
	});
}

function pinnedLookup(target: LookupAddress): LookupFunction {
	return (_hostname, options, callback) => {
		if (options.all) {
			callback(null, [target]);
			return;
		}
		callback(null, target.address, target.family);
	};
}

function normalizedHeaders(headers: http.IncomingHttpHeaders): Readonly<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value === "string") result[name.toLowerCase()] = value.slice(0, 8_192);
		else if (Array.isArray(value) && value.length > 0) result[name.toLowerCase()] = value[0]!.slice(0, 8_192);
	}
	return Object.freeze(result);
}

function projectContent(response: WebFetchResponse, url: URL): string {
	const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
	if (encoding && encoding !== "identity") {
		throw new WebFetchFailure("unsupported_content_encoding", "Compressed response encoding is not supported.");
	}
	const declaredType = mediaType(response.headers["content-type"]);
	const charset = contentCharset(response.headers["content-type"]);
	if (charset && charset !== "utf-8" && charset !== "utf8" && charset !== "us-ascii") {
		throw new WebFetchFailure("unsupported_charset", "Response character set is not supported.");
	}
	const text = new TextDecoder("utf-8").decode(response.body);
	if (declaredType === "text/html" || declaredType === "application/xhtml+xml") {
		return htmlToText(text);
	}
	if (declaredType === "application/json" || declaredType.endsWith("+json")) {
		try {
			return JSON.stringify(stableJsonValue(JSON.parse(text) as unknown), null, 2);
		} catch {
			throw new WebFetchFailure("invalid_content", "JSON response is invalid.");
		}
	}
	if (declaredType.startsWith("text/")
		|| declaredType === "application/xml"
		|| declaredType.endsWith("+xml")
		|| (!response.headers["content-type"] && !text.includes("\0"))) {
		return normalizeText(text);
	}
	throw new WebFetchFailure(
		"unsupported_content_type",
		`Response from ${displayHost(url)} is not a supported text format.`,
	);
}

function htmlToText(html: string): string {
	const document = parse(html);
	const parts: string[] = [];
	collectHtmlText(document, parts);
	return normalizeText(parts.join(""));
}

function collectHtmlText(node: DefaultTreeAdapterMap["node"], parts: string[]): void {
	if ("tagName" in node) {
		if (OMITTED_ELEMENTS.has(node.tagName)) return;
		if (BLOCK_ELEMENTS.has(node.tagName)) parts.push("\n");
	}
	if ("value" in node) parts.push(node.value);
	if ("childNodes" in node) {
		for (const child of node.childNodes) collectHtmlText(child, parts);
	}
	if ("tagName" in node && BLOCK_ELEMENTS.has(node.tagName)) parts.push("\n");
}

function normalizeText(value: string): string {
	return value
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replace(/[\t\f\v ]+/gu, " ")
		.replace(/ *\n */gu, "\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

function stableJsonValue(value: unknown, depth = 0): unknown {
	if (depth >= 64) return "[maximum depth omitted]";
	if (Array.isArray(value)) return value.map((item) => stableJsonValue(item, depth + 1));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [
		key,
		stableJsonValue(Reflect.get(value, key), depth + 1),
	]));
}

function externalOutput(url: URL, rawContent: string): string {
	const source = `Source: ${url.toString()}`;
	const safeContent = rawContent
		.replaceAll(EXTERNAL_START, "&lt;&lt;&lt;EXTERNAL_WEB_CONTENT_UNTRUSTED&gt;&gt;&gt;")
		.replaceAll(EXTERNAL_END, "&lt;&lt;&lt;END_EXTERNAL_WEB_CONTENT_UNTRUSTED&gt;&gt;&gt;");
	const fixedLength = [source, "", EXTERNAL_START, "", EXTERNAL_END].join("\n").length;
	const available = Math.max(0, TOOL_RESULT_OUTPUT_MAX_CHARS - fixedLength - 48);
	const content = safeContent.length <= available
		? safeContent
		: `${safeContent.slice(0, available)}\n[content truncated]`;
	return [source, "", EXTERNAL_START, content, EXTERNAL_END].join("\n");
}

function failureFrom(error: unknown, fallbackKind: string): ToolAdapterResult {
	return error instanceof WebFetchFailure
		? failure(error.kind, error.message)
		: failure(fallbackKind, "Web fetch failed.");
}

function failure(errorKind: string, message: string): ToolAdapterResult {
	return {
		success: false,
		modelOutput: `web_fetch failed\nError kind: ${errorKind}\nError: ${message}`,
		summary: "web_fetch failed",
		errorKind,
		metadata: Object.freeze({}),
	};
}

function mediaType(value: string | undefined): string {
	return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function contentCharset(value: string | undefined): string | undefined {
	const match = value?.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"']+)/iu);
	return match?.[1]?.trim().toLowerCase();
}

function positiveHeaderInteger(value: string | string[] | undefined): number | undefined {
	const raw = Array.isArray(value) ? value[0] : value;
	if (!raw || !/^\d+$/u.test(raw)) return undefined;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isRedirect(statusCode: number): boolean {
	return statusCode === 301 || statusCode === 302 || statusCode === 303
		|| statusCode === 307 || statusCode === 308;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
		throw new TypeError("web fetch bound is invalid");
	}
	return resolved;
}

function normalizedHostname(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function displayHost(url: URL): string {
	return url.hostname.slice(0, 253);
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

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
}
