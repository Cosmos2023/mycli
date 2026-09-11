import { access, open } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivateFileUpdate } from "../private-file-writer.ts";

const AUTH_FILE_NAME = "auth.json";
const AUTH_REF_MAX_CHARS = 512;

export interface ReadApiKeyOptions {
	readonly homeDir: string;
	readonly authRef: string;
}

export interface WriteApiKeyOptions extends ReadApiKeyOptions {
	readonly apiKey: string;
	readonly failpoint?: (name: string) => void;
}

export interface DeleteApiKeyOptions extends ReadApiKeyOptions {
	readonly failpoint?: (name: string) => void;
	readonly signal?: AbortSignal;
}

interface ApiKeyWriteReceipt {
	readonly previous: string | undefined;
	readonly committed: string;
}

export type AuthStoreState = "missing" | "valid" | "malformed";

export interface ApiKeyStatus {
	readonly authRef: string;
	readonly configured: boolean;
	readonly storeState: AuthStoreState;
}

export async function readApiKey(options: ReadApiKeyOptions): Promise<string | undefined> {
	const authRef = normalizedAuthRef(options.authRef);
	const store = await readAuthStore(options.homeDir);
	if (store.state !== "valid") return undefined;
	const credential = store.payload[authRef];
	if (!isRecord(credential) || credential.type !== "api_key") {
		return undefined;
	}
	const key = typeof credential.key === "string" ? credential.key.trim() : "";
	return key || undefined;
}

export async function inspectApiKey(options: ReadApiKeyOptions): Promise<ApiKeyStatus> {
	const authRef = normalizedAuthRef(options.authRef);
	const store = await readAuthStore(options.homeDir);
	if (store.state !== "valid") {
		return Object.freeze({ authRef, configured: false, storeState: store.state });
	}
	const credential = store.payload[authRef];
	const configured = isRecord(credential)
		&& credential.type === "api_key"
		&& typeof credential.key === "string"
		&& Boolean(credential.key.trim());
	return Object.freeze({ authRef, configured, storeState: "valid" });
}

export async function writeApiKey(options: WriteApiKeyOptions): Promise<void> {
	await writeApiKeyWithReceipt(options);
}

export async function withApiKeyReplacement<Value>(
	options: WriteApiKeyOptions & { readonly rollbackFailpoint?: (name: string) => void },
	commit: () => Promise<Value>,
): Promise<Value> {
	const receipt = await writeApiKeyWithReceipt(options);
	try {
		return await commit();
	} catch (error) {
		if (receipt) {
			await restoreApiKeyWrite(options.homeDir, receipt, options.rollbackFailpoint);
		}
		throw error;
	}
}

async function writeApiKeyWithReceipt(
	options: WriteApiKeyOptions,
): Promise<ApiKeyWriteReceipt | undefined> {
	const rawAuthRef = options.authRef.trim();
	const apiKey = options.apiKey.trim();
	if (!rawAuthRef || !apiKey) {
		throw new Error("auth_write_failed: authRef and apiKey must be non-empty");
	}
	const authRef = normalizedAuthRef(rawAuthRef);
	let receipt: ApiKeyWriteReceipt | undefined;
	try {
		const changed = await atomicPrivateFileUpdate({
			directory: join(options.homeDir, ".mycli"),
			fileName: AUTH_FILE_NAME,
			buildContent: (current) => {
				const payload = parseWritableAuthPayload(current);
				payload[authRef] = { type: "api_key", key: apiKey };
				return `${JSON.stringify(payload, null, 2)}\n`;
			},
			prepareCommit: ({ current, content }) => {
				if (content === null) throw new Error("invalid auth replacement");
				receipt = { previous: current, committed: content };
			},
			...(options.failpoint ? { failpoint: options.failpoint } : {}),
		});
		return changed ? receipt : undefined;
	} catch {
		throw new Error("auth_write_failed: unable to update credentials");
	}
}

async function restoreApiKeyWrite(
	homeDir: string,
	receipt: ApiKeyWriteReceipt,
	failpoint?: (name: string) => void,
): Promise<void> {
	try {
		await atomicPrivateFileUpdate({
			directory: join(homeDir, ".mycli"),
			fileName: AUTH_FILE_NAME,
			buildContent: (current) => {
				if (current !== receipt.committed) throw new Error("auth rollback conflict");
				return receipt.previous ?? null;
			},
			...(failpoint ? { failpoint } : {}),
		});
	} catch {
		throw new Error("auth_rollback_failed: credential state changed during rollback");
	}
}

export async function deleteApiKey(options: DeleteApiKeyOptions): Promise<boolean> {
	const authRef = normalizedAuthRef(options.authRef);
	const directory = join(options.homeDir, ".mycli");
	try {
		await access(directory);
	} catch {
		return false;
	}
	try {
		return await atomicPrivateFileUpdate({
			directory,
			fileName: AUTH_FILE_NAME,
			lockTimeoutMs: 20_000,
			...(options.signal ? { signal: options.signal } : {}),
			buildContent: (current) => {
				if (current === undefined) return undefined;
				const payload = parseWritableAuthPayload(current);
				if (!Object.hasOwn(payload, authRef)) return undefined;
				delete payload[authRef];
				return Object.keys(payload).length === 0
					? null
					: `${JSON.stringify(payload, null, 2)}\n`;
			},
			...(options.failpoint ? { failpoint: options.failpoint } : {}),
		});
	} catch {
		throw new Error("auth_delete_failed: unable to update credentials");
	}
}

export function parseWritableAuthPayload(raw: string | undefined): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) throw new Error("invalid auth payload");
		return Object.fromEntries(Object.entries(parsed));
	} catch {
		throw new Error("invalid auth payload");
	}
}

export async function readAuthStore(homeDir: string): Promise<
	| { readonly state: "missing" | "malformed" }
	| { readonly state: "valid"; readonly payload: Readonly<Record<string, unknown>> }
> {
	let raw: string;
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(join(homeDir, ".mycli", AUTH_FILE_NAME), "r");
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > 1024 * 1024) return { state: "malformed" };
		raw = await file.readFile("utf8");
		if (Buffer.byteLength(raw) > 1024 * 1024) return { state: "malformed" };
	} catch (error) {
		return isNodeError(error, "ENOENT") ? { state: "missing" } : { state: "malformed" };
	} finally {
		await file?.close();
	}
	try {
		const payload: unknown = JSON.parse(raw);
		return isRecord(payload)
			? { state: "valid", payload }
			: { state: "malformed" };
	} catch {
		return { state: "malformed" };
	}
}

export function normalizedAuthRef(value: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > AUTH_REF_MAX_CHARS || /[\r\n\0]/u.test(normalized)) {
		throw new Error("auth_ref_invalid: authRef must be a bounded non-empty identity");
	}
	return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
