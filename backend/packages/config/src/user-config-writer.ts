import { join } from "node:path";
import type { ProtocolId, ProviderId, ReasoningEffort } from "@mycli/core";
import { resolveProviderProfile } from "./provider-profiles.ts";
import type { WorkspaceTrustState } from "./workspace-trust-store.ts";
import {
	applyUserConfigEdits,
	type UserConfigEdit,
} from "./user-config-editor.ts";

export interface UserProviderConfigInput {
	readonly homeDir: string;
	readonly provider: ProviderId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly apiBaseUrl: string;
	readonly authRef: string;
	readonly promptCacheKeyEnabled: boolean;
	readonly cacheControlEnabled: boolean;
	readonly thinkingEnabled?: boolean;
	readonly reasoningEffort?: ReasoningEffort;
	readonly workspaceRoot?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly workspaceTrust?: WorkspaceTrustState;
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
		await applyUserConfigEdits({
			homeDir: input.homeDir,
			workspaceRoot: input.workspaceRoot ?? input.homeDir,
			env: input.env ?? {},
			workspaceTrust: input.workspaceTrust ?? "untrusted",
			edits: providerConfigEdits(input),
			validateCurrent: false,
			...(input.failpoint ? { failpoint: input.failpoint } : {}),
		});
		return join(directory, "config.toml");
	} catch {
		throw new Error("config_write_failed: unable to update user config");
	}
}

function providerConfigEdits(input: UserProviderConfigInput): readonly UserConfigEdit[] {
	const edits: UserConfigEdit[] = [
		clear("api_key"),
		...LEGACY_MODEL_KEYS
			.filter((key) => key !== "model")
			.map((key) => clear(key)),
		...LEGACY_REQUEST_KEYS.map((key) => clear(key)),
		{ action: "clear", path: ["model", "api_key"] },
		set(["model", "provider"], input.provider),
		set(["model", "protocol"], input.protocol),
		set(["model", "name"], input.model.trim()),
		set(["model", "api_base_url"], input.apiBaseUrl.trim().replace(/\/+$/u, "")),
		set(["model", "auth_ref"], input.authRef.trim()),
		set(["request", "prompt_cache_key_enabled"], input.promptCacheKeyEnabled),
		set(["request", "cache_control_enabled"], input.cacheControlEnabled),
	];
	if (input.thinkingEnabled !== undefined || input.reasoningEffort !== undefined) {
		if (input.thinkingEnabled !== undefined) {
			edits.push(set(["reasoning", "enabled"], input.thinkingEnabled));
		}
		if (input.reasoningEffort !== undefined) {
			edits.push(set(["reasoning", "reasoning_effort"], input.reasoningEffort));
			if (input.thinkingEnabled !== false) {
				edits.push(set(["reasoning", "effort"], input.reasoningEffort));
			}
		}
		if (input.thinkingEnabled === false) {
			edits.push({ action: "clear", path: ["reasoning", "effort"] });
		}
	}
	return edits;
}

function clear(key: string): UserConfigEdit {
	return { action: "clear", path: [key] };
}

function set(
	path: readonly string[],
	value: string | boolean,
): UserConfigEdit {
	return { action: "set", path, value };
}
