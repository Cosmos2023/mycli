import { realpath, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import {
	ContractValidationError,
	parsePluginV2Manifest,
} from "@mycli/contracts";
import { parse as parseYaml } from "yaml";
import type {
	LoadedPluginManifest,
	PluginDiagnostic,
	PluginManifestLoadResult,
	PluginSource,
} from "./types.ts";

export interface LoadPluginManifestOptions {
	readonly pluginRoot: string;
	readonly source: PluginSource;
	readonly expectedPluginId?: string;
	readonly maxManifestBytes?: number;
}

const DEFAULT_MAX_MANIFEST_BYTES = 65_536;
const MAX_MANIFEST_BYTES = 1_048_576;
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export async function loadPluginManifest(
	options: LoadPluginManifestOptions,
): Promise<PluginManifestLoadResult> {
	const pluginId = safePluginId(options.expectedPluginId ?? basename(options.pluginRoot));
	const manifestPath = join(options.pluginRoot, "plugin.yaml");
	const maximum = manifestSizeLimit(options.maxManifestBytes);
	let bytes: Buffer;
	try {
		const metadata = await stat(manifestPath);
		if (!metadata.isFile()) return invalid(options.source, pluginId, "manifest_not_file");
		if (metadata.size > maximum) return invalid(options.source, pluginId, "manifest_too_large");
		bytes = await readFile(manifestPath);
		if (bytes.byteLength > maximum) return invalid(options.source, pluginId, "manifest_too_large");
	} catch (error) {
		return invalid(
			options.source,
			pluginId,
			errorCode(error) === "ENOENT" ? "manifest_missing" : "manifest_read_failed",
		);
	}
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return invalid(options.source, pluginId, "invalid_utf8");
	}

	let payload: unknown;
	try {
		payload = parseYaml(raw);
	} catch {
		return invalid(options.source, pluginId, "invalid_yaml");
	}

	let parsed;
	try {
		parsed = parsePluginV2Manifest(payload);
	} catch (error) {
		return invalid(
			options.source,
			pluginId,
			error instanceof ContractValidationError ? "invalid_manifest" : "manifest_validation_failed",
		);
	}
	if (options.expectedPluginId && parsed.id !== options.expectedPluginId) {
		return invalid(options.source, pluginId, "plugin_id_mismatch");
	}

	let pluginRoot: string;
	let entryPath: string;
	try {
		pluginRoot = await realpath(options.pluginRoot);
		entryPath = await realpath(join(pluginRoot, parsed.entry));
	} catch (error) {
		return invalid(
			options.source,
			pluginId,
			errorCode(error) === "ENOENT" ? "entry_missing" : "entry_read_failed",
		);
	}
	if (outside(pluginRoot, entryPath)) {
		return invalid(options.source, pluginId, "entry_path_escape");
	}
	try {
		if (!(await stat(entryPath)).isFile()) {
			return invalid(options.source, pluginId, "entry_not_file");
		}
	} catch {
		return invalid(options.source, pluginId, "entry_read_failed");
	}

	const manifest = freezeManifest({
		...parsed,
		source: options.source,
		pluginRoot,
		manifestPath: join(pluginRoot, "plugin.yaml"),
		entryPath,
	});
	return Object.freeze({ kind: "loaded", manifest });
}

function freezeManifest(value: LoadedPluginManifest): LoadedPluginManifest {
	return Object.freeze({
		...value,
		provides: {
			tools: [...value.provides.tools],
			hooks: [...value.provides.hooks],
			commands: [...value.provides.commands],
		},
		requires_env: [...value.requires_env],
		capabilities: [...value.capabilities] as LoadedPluginManifest["capabilities"],
	});
}

function invalid(
	source: PluginSource,
	pluginId: string,
	errorClass: string,
): PluginManifestLoadResult {
	const diagnostic: PluginDiagnostic = Object.freeze({
		source,
		pluginId,
		fileLabel: "plugin.yaml",
		errorClass,
	});
	return Object.freeze({ kind: "invalid", diagnostic });
}

function outside(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
		|| isAbsolute(fromRoot);
}

function safePluginId(value: string): string {
	return PLUGIN_ID.test(value) ? value : "plugin";
}

function manifestSizeLimit(value: number | undefined): number {
	const selected = value ?? DEFAULT_MAX_MANIFEST_BYTES;
	if (!Number.isSafeInteger(selected) || selected <= 0 || selected > MAX_MANIFEST_BYTES) {
		throw new RangeError("invalid_plugin_manifest_size_limit");
	}
	return selected;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
