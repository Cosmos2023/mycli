import { join } from "node:path";
import {
	resolveConfigProfilePath,
	resolveSystemConfigPath,
	type ConfigProfileName,
} from "./config-profile.ts";

export const CONFIG_PATH_SCOPES = Object.freeze([
	"user",
	"project",
	"profile",
	"system",
	"legacy_user",
] as const);

export type ConfigPathScope = typeof CONFIG_PATH_SCOPES[number];

export interface ResolveConfigPathOptions {
	readonly scope: ConfigPathScope;
	readonly homeDir: string;
	readonly workspaceRoot: string;
	readonly configProfile?: ConfigProfileName;
	readonly platform?: NodeJS.Platform;
	readonly programDataDir?: string;
	readonly systemConfigPath?: string;
}

export interface ResolvedConfigPath {
	readonly scope: ConfigPathScope;
	readonly path: string;
	readonly writable: boolean;
}

export function resolveConfigPath(options: ResolveConfigPathOptions): ResolvedConfigPath {
	if (!CONFIG_PATH_SCOPES.includes(options.scope)) {
		throw new Error("config_path_scope_invalid");
	}
	let path: string;
	if (options.scope === "user") {
		path = join(options.homeDir, ".mycli", "config.toml");
	} else if (options.scope === "project") {
		path = join(options.workspaceRoot, ".mycli", "config.toml");
	} else if (options.scope === "profile") {
		if (!options.configProfile) throw new Error("config_profile_required");
		path = resolveConfigProfilePath(options.homeDir, options.configProfile);
	} else if (options.scope === "system") {
		path = options.systemConfigPath ?? resolveSystemConfigPath({
			...(options.platform ? { platform: options.platform } : {}),
			...(options.programDataDir ? { programDataDir: options.programDataDir } : {}),
		});
	} else {
		path = join(options.homeDir, ".config", "mycli", "config.toml");
	}
	return Object.freeze({
		scope: options.scope,
		path,
		writable: options.scope === "user",
	});
}
