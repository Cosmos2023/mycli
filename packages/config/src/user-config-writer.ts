import { join } from "node:path";
import type { ProtocolId, ProviderId } from "@mycli/core";
import { parse, stringify } from "smol-toml";
import { atomicPrivateFileUpdate } from "./private-file-writer.ts";
import { resolveProviderProfile } from "./provider-profiles.ts";

export interface UserProviderConfigInput {
	readonly homeDir: string;
	readonly provider: ProviderId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly apiBaseUrl: string;
	readonly authRef: string;
	readonly promptCacheKeyEnabled: boolean;
	readonly cacheControlEnabled: boolean;
	readonly failpoint?: (name: string) => void;
}

const LEGACY_MODEL_KEYS = [
	"provider",
	"protocol",
	"model",
	"api_base_url",
	"auth_ref",
] as const;

const LEGACY_REQUEST_KEYS = [
	"prompt_cache_key_enabled",
	"cache_control_enabled",
] as const;

export async function writeUserProviderConfig(
	input: UserProviderConfigInput,
): Promise<string> {
	const values = [input.provider, input.protocol, input.model, input.apiBaseUrl, input.authRef]
		.map((value) => value.trim());
	if (values.some((value) => !value)) {
		throw new Error("config_write_failed: provider settings must be non-empty");
	}
	try {
		resolveProviderProfile(input.provider, input.protocol);
		const directory = join(input.homeDir, ".mycli");
		await atomicPrivateFileUpdate({
			directory,
			fileName: "config.toml",
			buildContent: (current) => serializeConfig(current, input),
			...(input.failpoint ? { failpoint: input.failpoint } : {}),
		});
		return join(directory, "config.toml");
	} catch {
		throw new Error("config_write_failed: unable to update user config");
	}
}

function serializeConfig(current: string | undefined, input: UserProviderConfigInput): string {
	const payload = parsePayload(current);
	delete payload.api_key;
	for (const key of LEGACY_MODEL_KEYS) delete payload[key];
	for (const key of LEGACY_REQUEST_KEYS) delete payload[key];
	const model = recordCopy(payload.model);
	delete model.api_key;
	Object.assign(model, {
		provider: input.provider,
		protocol: input.protocol,
		name: input.model.trim(),
		api_base_url: input.apiBaseUrl.trim().replace(/\/+$/u, ""),
		auth_ref: input.authRef.trim(),
	});
	const request = recordCopy(payload.request);
	Object.assign(request, {
		prompt_cache_key_enabled: input.promptCacheKeyEnabled,
		cache_control_enabled: input.cacheControlEnabled,
	});
	payload.model = model;
	payload.request = request;
	return `${stringify(payload).trimEnd()}\n`;
}

function parsePayload(raw: string | undefined): Record<string, unknown> {
	if (!raw) return {};
	const parsed: unknown = parse(raw);
	if (!isRecord(parsed)) throw new Error("invalid_config");
	return { ...parsed };
}

function recordCopy(value: unknown): Record<string, unknown> {
	return isRecord(value) ? { ...value } : {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
