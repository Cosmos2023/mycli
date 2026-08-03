import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ReadApiKeyOptions {
	readonly homeDir: string;
	readonly authRef: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
