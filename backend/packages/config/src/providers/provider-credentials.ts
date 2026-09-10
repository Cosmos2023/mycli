import { join } from "node:path";
import { atomicPrivateFileUpdate } from "../private-file-writer.ts";
import { normalizedAuthRef, parseWritableAuthPayload, readAuthStore } from "./auth-store.ts";

export type CredentialJsonValue = string | number | boolean | null
	| readonly CredentialJsonValue[] | { readonly [key: string]: CredentialJsonValue };

export type ProviderCredential = {
	readonly type: "api_key";
	readonly key?: string;
	readonly env?: Readonly<Record<string, string>>;
} | {
	readonly type: "oauth";
	readonly access: string;
	readonly refresh: string;
	readonly expires: number;
	readonly metadata?: Readonly<Record<string, CredentialJsonValue>>;
};

export interface ProviderCredentialOptions {
	readonly homeDir: string;
	readonly authRef: string;
	readonly signal?: AbortSignal;
}

const MAX_STORE_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 128 * 1024;

export async function readProviderCredential(options: ProviderCredentialOptions): Promise<ProviderCredential | undefined> {
	const authRef = normalizedAuthRef(options.authRef);
	options.signal?.throwIfAborted();
	const store = await readAuthStore(options.homeDir);
	options.signal?.throwIfAborted();
	if (store.state === "malformed") throw invalid();
	return store.state === "valid" && Object.hasOwn(store.payload, authRef)
		? parseProviderCredential(store.payload[authRef]) : undefined;
}

export async function modifyProviderCredential(
	options: ProviderCredentialOptions,
	modify: (current: ProviderCredential | undefined) => Promise<ProviderCredential | undefined>,
): Promise<ProviderCredential | undefined> {
	const authRef = normalizedAuthRef(options.authRef);
	let result: ProviderCredential | undefined;
	try {
		await atomicPrivateFileUpdate({
			directory: join(options.homeDir, ".mycli"), fileName: "auth.json", lockTimeoutMs: 20_000,
			...(options.signal ? { signal: options.signal } : {}),
			buildContent: async (current) => {
				if (current && Buffer.byteLength(current) > MAX_STORE_BYTES) throw invalid();
				const payload = parseWritableAuthPayload(current);
				const previous = Object.hasOwn(payload, authRef) ? parseProviderCredential(payload[authRef]) : undefined;
				const next = await modify(previous);
				result = next === undefined ? previous : parseProviderCredential(next);
				if (next === undefined) return undefined;
				payload[authRef] = result;
				const serialized = `${JSON.stringify(payload, null, 2)}\n`;
				if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw invalid();
				return serialized;
			},
		});
		return result;
	} catch {
		if (options.signal?.aborted) throw options.signal.reason;
		throw invalid();
	}
}

export function parseProviderCredential(value: unknown): ProviderCredential {
	if (!isRecord(value) || Buffer.byteLength(JSON.stringify(value)) > MAX_CREDENTIAL_BYTES) throw invalid();
	if (value.type === "api_key") {
		if (Object.keys(value).some((key) => !["type", "key", "env"].includes(key))) throw invalid();
		const key = value.key === undefined ? undefined : secret(value.key);
		const env = value.env === undefined ? undefined : environment(value.env);
		if (!key && !env) throw invalid();
		return Object.freeze({ type: "api_key", ...(key ? { key } : {}), ...(env ? { env } : {}) });
	}
	if (value.type === "oauth") {
		if (Object.keys(value).some((key) => !["type", "access", "refresh", "expires", "metadata"].includes(key))) throw invalid();
		if (typeof value.expires !== "number" || !Number.isSafeInteger(value.expires) || value.expires < 0) throw invalid();
		const metadata = value.metadata === undefined ? undefined : jsonRecord(value.metadata, 0);
		return Object.freeze({ type: "oauth", access: secret(value.access), refresh: value.refresh === "" ? "" : secret(value.refresh), expires: value.expires,
			...(metadata ? { metadata } : {}) });
	}
	throw invalid();
}

function environment(value: unknown): Readonly<Record<string, string>> {
	if (!isRecord(value) || Object.keys(value).length > 128) throw invalid();
	return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => {
		if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(key) || typeof entry !== "string" || entry.length > 16_384 || entry.includes("\0")) throw invalid();
		return [key, entry];
	})));
}

function jsonRecord(value: unknown, depth: number): Readonly<Record<string, CredentialJsonValue>> {
	if (!isRecord(value) || depth > 8 || Object.keys(value).length > 128) throw invalid();
	return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => {
		if (key.length > 128 || ["__proto__", "constructor", "prototype", "type", "access", "refresh", "expires"].includes(key)) throw invalid();
		return [key, jsonValue(entry, depth + 1)];
	})));
}

function jsonValue(value: unknown, depth: number): CredentialJsonValue {
	if (depth > 8) throw invalid();
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value) && value.length <= 128) return Object.freeze(value.map((entry) => jsonValue(entry, depth + 1)));
	return jsonRecord(value, depth);
}

function secret(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 65_536 || /[\r\n\0]/u.test(value)) throw invalid();
	return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): Error {
	return new Error("auth_credential_failed: credential could not be read or updated");
}
