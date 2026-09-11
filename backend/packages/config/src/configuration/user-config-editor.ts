import { join } from "node:path";
import { parseDocument } from "@decimalturn/toml-patch";
import {
	configError,
	isConfigError,
} from "./config-diagnostics.ts";
import { atomicPrivateFileUpdate } from "../private-file-writer.ts";
import {
	hasRuntimeSetting,
	writableRuntimeSetting,
	type UserConfigScalar,
	type WritableRuntimeSetting,
} from "./runtime-setting-catalog.ts";
import {
	resolveConfigWithUserConfigText,
	type ResolveConfigOptions,
} from "./settings.ts";
import { valueAtPath } from "./config-value.ts";

export interface UserConfigMutationOptions extends ResolveConfigOptions {
	readonly action: "set" | "unset";
	readonly key: string;
	readonly value?: string;
}

export interface UserConfigMutationResult {
	readonly key: string;
	readonly changed: boolean;
}

export type UserConfigEdit =
	| {
		readonly action: "set";
		readonly path: readonly string[];
		readonly value: UserConfigScalar;
	}
	| {
		readonly action: "clear";
		readonly path: readonly string[];
		readonly onlyIfScalar?: boolean;
	};

export interface ApplyUserConfigEditsOptions extends ResolveConfigOptions {
	readonly edits: readonly UserConfigEdit[];
	readonly validateCurrent?: boolean;
	readonly failpoint?: (name: string) => void;
}

type MutableConfigMap = Record<string, unknown>;

export async function mutateUserConfigSetting(
	options: UserConfigMutationOptions,
): Promise<UserConfigMutationResult> {
	const setting = requireWritableSetting(options.key);
	const value = options.action === "set"
		? parseSettingValue(setting, options.value)
		: undefined;
	const edits = settingEdits(setting, options.action, value);
	const changed = await applyUserConfigEdits({
		...options,
		edits,
		validateCurrent: true,
	});
	return Object.freeze({ key: setting.key, changed });
}

export async function applyUserConfigEdits(
	options: ApplyUserConfigEditsOptions,
): Promise<boolean> {
	try {
		return await atomicPrivateFileUpdate({
			directory: join(options.homeDir, ".mycli"),
			fileName: "config.toml",
			buildContent: async (current) => {
				const source = current ?? "";
				if (options.validateCurrent !== false) {
					await validateUserConfigCandidate(options, source);
				}
				const candidate = buildUserConfigCandidate(source, options.edits);
				if (candidate === source) {
					if (options.validateCurrent === false) {
						await validateUserConfigCandidate(options, candidate);
					}
					return undefined;
				}
				await validateUserConfigCandidate(options, candidate);
				return candidate;
			},
			...(options.failpoint ? { failpoint: options.failpoint } : {}),
		});
	} catch (error) {
		if (isConfigError(error)) throw error;
		throw configError({
			code: "config_write_failed",
			severity: "error",
			layer: "user",
			message: "user config could not be updated",
			remediation: "Check that the user configuration directory is writable and try again.",
		});
	}
}

export function buildUserConfigCandidate(
	source: string,
	edits: readonly UserConfigEdit[],
): string {
	const document = parseDocument(source);
	const payload = mutableRecord(document.toJsObject);
	for (const edit of edits) {
		if (edit.action === "set") {
			setPath(payload, edit.path, edit.value);
		} else if (!edit.onlyIfScalar || !isRecord(valueAtPath(payload, edit.path))) {
			deletePath(payload, edit.path);
		}
	}
	document.patch(payload);
	return document.toTomlString;
}

function settingEdits(
	setting: WritableRuntimeSetting,
	action: "set" | "unset",
	value: UserConfigScalar | undefined,
): readonly UserConfigEdit[] {
	const edits: UserConfigEdit[] = [];
	if (action === "set") {
		for (const legacyPath of setting.legacyPaths) {
			if (!isPathPrefix(legacyPath, setting.path)) {
				edits.push({ action: "clear", path: legacyPath });
			}
		}
		edits.push({ action: "set", path: setting.path, value: value! });
		return edits;
	}
	edits.push({ action: "clear", path: setting.path });
	for (const legacyPath of setting.legacyPaths) {
		edits.push({
			action: "clear",
			path: legacyPath,
			...(isPathPrefix(legacyPath, setting.path) ? { onlyIfScalar: true } : {}),
		});
	}
	return edits;
}

function requireWritableSetting(key: string): WritableRuntimeSetting {
	const setting = writableRuntimeSetting(key);
	if (setting) return setting;
	throw configError({
		code: "invalid_value",
		severity: "error",
		layer: "user",
		...(hasRuntimeSetting(key) ? { keyPath: key } : {}),
		message: hasRuntimeSetting(key)
			? "configuration setting is read-only"
			: "configuration setting is not supported",
		remediation: "Use 'mycli config show' to list supported settings.",
	});
}

function parseSettingValue(
	setting: WritableRuntimeSetting,
	raw: string | undefined,
): UserConfigScalar {
	if (raw === undefined) throw invalidValue(setting.key);
	if (setting.valueKind === "string") {
		const value = raw.trim();
		if (!value) throw invalidValue(setting.key);
		if (setting.allowedValues && !setting.allowedValues.includes(value)) {
			throw invalidValue(setting.key);
		}
		return value;
	}
	if (setting.valueKind === "boolean") {
		if (raw === "true") return true;
		if (raw === "false") return false;
		throw invalidValue(setting.key);
	}
	if (setting.valueKind === "integer") {
		if (!/^[+-]?(?:0|[1-9]\d*)$/u.test(raw)) throw invalidValue(setting.key);
		const value = Number(raw);
		if (!Number.isSafeInteger(value)) throw invalidValue(setting.key);
		return value;
	}
	return parseFiniteNumber(setting.key, raw);
}

function parseFiniteNumber(
	key: string,
	raw: string,
): number {
	if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(raw)) {
		throw invalidValue(key);
	}
	const value = Number(raw);
	if (!Number.isFinite(value)) throw invalidValue(key);
	return value;
}

function invalidValue(key: string): Error {
	return configError({
		code: "invalid_value",
		severity: "error",
		layer: "user",
		keyPath: key,
		message: "configuration value is invalid for this setting",
		remediation: "Use the value type shown by 'mycli config show' and try again.",
	});
}

export async function validateUserConfigCandidate(
	options: ResolveConfigOptions,
	candidate: string,
): Promise<void> {
	await resolveConfigWithUserConfigText({
		...options,
		env: {},
		overrides: undefined,
		workspaceTrust: "untrusted",
	}, candidate);
	await resolveConfigWithUserConfigText(options, candidate);
}

function setPath(payload: MutableConfigMap, path: readonly string[], value: UserConfigScalar): void {
	let target = payload;
	for (const segment of path.slice(0, -1)) {
		const child = target[segment];
		if (isRecord(child)) {
			target = child;
			continue;
		}
		const replacement: MutableConfigMap = {};
		target[segment] = replacement;
		target = replacement;
	}
	target[path.at(-1)!] = value;
}

function deletePath(payload: MutableConfigMap, path: readonly string[]): boolean {
	let target = payload;
	for (const segment of path.slice(0, -1)) {
		const child = target[segment];
		if (!isRecord(child)) return false;
		target = child;
	}
	return delete target[path.at(-1)!];
}

function isPathPrefix(prefix: readonly string[], path: readonly string[]): boolean {
	return prefix.length < path.length && prefix.every((segment, index) => path[index] === segment);
}

function mutableRecord(value: unknown): MutableConfigMap {
	if (!isRecord(value)) throw new Error("invalid_config_document");
	return value;
}

function isRecord(value: unknown): value is MutableConfigMap {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
