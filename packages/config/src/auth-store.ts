import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivateFileUpdate } from "./private-file-writer.ts";

export interface ReadApiKeyOptions {
	readonly homeDir: string;
	readonly authRef: string;
}

export interface WriteApiKeyOptions extends ReadApiKeyOptions {
	readonly apiKey: string;
	readonly failpoint?: (name: string) => void;
}

export async function readApiKey(options: ReadApiKeyOptions): Promise<string | undefined> {
	let raw: string;
	try {
		raw = await readFile(join(options.homeDir, ".mycli", "auth.json"), "utf8");
	} catch {
		return undefined;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(payload)) {
		return undefined;
	}
	const credential = payload[options.authRef];
	if (!isRecord(credential) || credential.type !== "api_key") {
		return undefined;
	}
	const key = typeof credential.key === "string" ? credential.key.trim() : "";
	return key || undefined;
}

export async function writeApiKey(options: WriteApiKeyOptions): Promise<void> {
	const authRef = options.authRef.trim();
	const apiKey = options.apiKey.trim();
	if (!authRef || !apiKey) {
		throw new Error("auth_write_failed: authRef and apiKey must be non-empty");
	}
	try {
		await atomicPrivateFileUpdate({
			directory: join(options.homeDir, ".mycli"),
			fileName: "auth.json",
			buildContent: (current) => {
				const payload = parseAuthPayload(current);
				payload[authRef] = { type: "api_key", key: apiKey };
				return `${JSON.stringify(payload, null, 2)}\n`;
			},
			...(options.failpoint ? { failpoint: options.failpoint } : {}),
		});
	} catch {
		throw new Error("auth_write_failed: unable to update credentials");
	}
}

function parseAuthPayload(raw: string | undefined): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? { ...parsed } : {};
	} catch {
		return {};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
