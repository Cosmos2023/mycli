import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export const SYSTEM_PROMPT_VERSION = "2026-09-codex-style-base-v23";
export const SYSTEM_PROMPT_SOURCE = "builtin-system-md";

export interface PackagedSystemPrompt {
	readonly version: string;
	readonly source: string;
	readonly content: string;
	readonly contentSha256: string;
}

export function loadSystemPromptTemplate(): string {
	const asset = systemPromptAssetUrl();
	return readFileSync(asset, "utf8").trim();
}

export function packagedSystemPrompt(): PackagedSystemPrompt {
	const content = loadSystemPromptTemplate();
	return Object.freeze({
		version: SYSTEM_PROMPT_VERSION,
		source: SYSTEM_PROMPT_SOURCE,
		content,
		contentSha256: createHash("sha256").update(content).digest("hex"),
	});
}

function systemPromptAssetUrl(): URL {
	const asset = new URL("../assets/system.md", import.meta.url);
	if (existsSync(asset)) return asset;
	throw new Error("system_prompt_asset_missing");
}
