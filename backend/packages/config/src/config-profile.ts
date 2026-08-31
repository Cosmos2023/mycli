import { join, win32 } from "node:path";

declare const CONFIG_PROFILE_NAME: unique symbol;

export type ConfigProfileName = string & {
	readonly [CONFIG_PROFILE_NAME]: true;
};

const PLAIN_PROFILE_NAME = /^[A-Za-z0-9_-]+$/u;
const WINDOWS_PROGRAM_DATA_FALLBACK = String.raw`C:\ProgramData`;

export class ConfigProfileNameError extends Error {
	constructor() {
		super("invalid_config_profile_name");
		this.name = "ConfigProfileNameError";
	}
}

export function parseConfigProfileName(value: string): ConfigProfileName {
	if (!PLAIN_PROFILE_NAME.test(value)) throw new ConfigProfileNameError();
	return value as ConfigProfileName;
}

export function resolveConfigProfilePath(
	homeDir: string,
	profile: ConfigProfileName,
): string {
	const validated = parseConfigProfileName(profile);
	return join(homeDir, ".mycli", `${validated}.config.toml`);
}

export interface ResolveSystemConfigPathOptions {
	readonly platform?: NodeJS.Platform;
	readonly programDataDir?: string;
}

export function resolveSystemConfigPath(
	options: ResolveSystemConfigPathOptions = {},
): string {
	if ((options.platform ?? process.platform) !== "win32") {
		return "/etc/mycli/config.toml";
	}
	const configured = options.programDataDir?.trim();
	const programDataDir = configured && win32.isAbsolute(configured)
		? configured
		: WINDOWS_PROGRAM_DATA_FALLBACK;
	return win32.join(programDataDir, "mycli", "config.toml");
}
