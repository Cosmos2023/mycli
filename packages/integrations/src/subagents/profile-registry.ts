import { basename, join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { BUILTIN_SUBAGENT_PROFILES } from "./builtin-profiles.ts";
import type {
	SubagentBudget,
	SubagentProfile,
	SubagentProfileIssue,
	SubagentProfileRecord,
	SubagentProfileRegistryDiagnostics,
} from "./types.ts";

export interface SubagentProfileRegistryOptions {
	readonly homeDir: string;
	readonly workspaceRoot: string;
	readonly maxFileBytes?: number;
	readonly maxProfiles?: number;
}

interface ProfileDirectory {
	readonly root: string;
	readonly sourceKind: "user" | "repo";
	readonly sourceDirectory: "subagents" | "agents";
}

interface ProfileLimits {
	readonly maxFileBytes: number;
	readonly maxProfiles: number;
}

interface ParsedProfileFile {
	readonly payload: Readonly<Record<string, unknown>>;
	readonly body?: string;
}

interface LoadedProfile {
	readonly profile: SubagentProfile;
	readonly enabled: boolean;
}

const DEFAULT_MAX_FILE_BYTES = 131_072;
const DEFAULT_MAX_PROFILES = 256;
const MAX_PROMPT_CHARS = 65_536;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_MODEL_CHARS = 256;
const MAX_TOOLS = 128;
const MAX_TOOL_NAME_CHARS = 128;
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

class ProfileFileError extends Error {
	readonly code: string;
	readonly profileId: string;

	constructor(code: string, profileId: string) {
		super(code);
		this.code = code;
		this.profileId = profileId;
	}
}

export class SubagentProfileRegistry {
	readonly #records: readonly SubagentProfileRecord[];
	readonly #profiles: ReadonlyMap<string, SubagentProfile>;
	readonly #diagnostics: SubagentProfileRegistryDiagnostics;

	private constructor(
		records: readonly SubagentProfileRecord[],
		diagnostics: SubagentProfileRegistryDiagnostics,
	) {
		this.#records = records;
		this.#profiles = new Map(records.flatMap((record) =>
			record.status === "enabled" && record.profile
				? [[record.id, record.profile] as const]
				: []
		));
		this.#diagnostics = diagnostics;
	}

	static async discover(options: SubagentProfileRegistryOptions): Promise<SubagentProfileRegistry> {
		const limits = resolveLimits(options);
		const records = new Map<string, SubagentProfileRecord>();
		for (const profile of BUILTIN_SUBAGENT_PROFILES) {
			records.set(profile.id, recordForProfile(profile, true));
		}
		const issues: SubagentProfileIssue[] = [];
		let discoveredCount = 0;
		let duplicateCount = 0;
		for (const directory of profileDirectories(options)) {
			let paths: readonly string[];
			try {
				paths = await profilePaths(directory.root);
			} catch {
				issues.push(issue({
					profileId: basename(directory.root),
					sourceKind: directory.sourceKind,
					fileLabel: basename(directory.root),
					errorClass: "directory_read_failed",
				}));
				continue;
			}
			for (const path of paths) {
				discoveredCount += 1;
				if (discoveredCount > limits.maxProfiles) {
					issues.push(issue({
						profileId: basename(path).slice(0, 64),
						sourceKind: directory.sourceKind,
						fileLabel: basename(path),
						errorClass: "profile_limit_exceeded",
					}));
					continue;
				}
				const record = await loadProfile(path, directory, limits);
				if (records.has(record.id)) duplicateCount += 1;
				records.set(record.id, record);
				issues.push(...record.issues);
			}
		}
		const ordered = Object.freeze([...records.values()].sort((left, right) =>
			compareText(left.id, right.id)
		));
		const diagnostics = Object.freeze({
			discoveredCount,
			loadedCount: ordered.filter((record) => record.status !== "failed").length,
			enabledCount: ordered.filter((record) => record.status === "enabled").length,
			disabledCount: ordered.filter((record) => record.status === "disabled").length,
			duplicateCount,
			issueCount: issues.length,
			issues: Object.freeze(issues),
		});
		return new SubagentProfileRegistry(ordered, diagnostics);
	}

	get(id: string): SubagentProfile | undefined {
		return this.#profiles.get(id.trim());
	}

	list(): readonly SubagentProfile[] {
		return Object.freeze([...this.#profiles.values()].sort((left, right) =>
			compareText(left.id, right.id)
		));
	}

	records(): readonly SubagentProfileRecord[] {
		return this.#records;
	}

	diagnostics(): SubagentProfileRegistryDiagnostics {
		return this.#diagnostics;
	}
}

function profileDirectories(options: SubagentProfileRegistryOptions): readonly ProfileDirectory[] {
	return [
		{
			root: join(options.homeDir, ".mycli", "subagents"),
			sourceKind: "user",
			sourceDirectory: "subagents",
		},
		{
			root: join(options.homeDir, ".mycli", "agents"),
			sourceKind: "user",
			sourceDirectory: "agents",
		},
		{
			root: join(options.workspaceRoot, ".mycli", "subagents"),
			sourceKind: "repo",
			sourceDirectory: "subagents",
		},
		{
			root: join(options.workspaceRoot, ".mycli", "agents"),
			sourceKind: "repo",
			sourceDirectory: "agents",
		},
	];
}

function resolveLimits(options: SubagentProfileRegistryOptions): ProfileLimits {
	return {
		maxFileBytes: positiveLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1_048_576),
		maxProfiles: positiveLimit(options.maxProfiles, DEFAULT_MAX_PROFILES, 1_024),
	};
}

function positiveLimit(value: number | undefined, fallback: number, maximum: number): number {
	const selected = value ?? fallback;
	if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
		throw new Error("invalid_subagent_profile_registry_limit");
	}
	return selected;
}

async function profilePaths(root: string): Promise<readonly string[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	return Object.freeze(entries
		.filter((entry) => entry.isFile() && (entry.name.endsWith(".toml") || entry.name.endsWith(".md")))
		.sort((left, right) => compareText(left.name, right.name))
		.map((entry) => join(root, entry.name)));
}

async function loadProfile(
	path: string,
	directory: ProfileDirectory,
	limits: ProfileLimits,
): Promise<SubagentProfileRecord> {
	const fallbackId = basename(path).replace(/\.(?:toml|md)$/u, "").slice(0, 64) || "profile";
	try {
		const loaded = await parseProfile(path, directory, limits, fallbackId);
		return recordForProfile(loaded.profile, loaded.enabled);
	} catch (error) {
		const failure = error instanceof ProfileFileError
			? error
			: new ProfileFileError("profile_read_failed", fallbackId);
		const profileIssue = issue({
			profileId: failure.profileId,
			sourceKind: directory.sourceKind,
			fileLabel: basename(path),
			errorClass: failure.code,
		});
		return Object.freeze({
			id: failure.profileId,
			status: "failed",
			enabled: false,
			sourceKind: directory.sourceKind,
			sourceDirectory: directory.sourceDirectory,
			fileLabel: path,
			issues: Object.freeze([profileIssue]),
		});
	}
}

async function parseProfile(
	path: string,
	directory: ProfileDirectory,
	limits: ProfileLimits,
	fallbackId: string,
): Promise<LoadedProfile> {
	const parsed = await parsedFile(path, limits, fallbackId);
	const payload = parsed.payload;
	const profileId = profileIdValue(firstDefined(payload, ["id", "name"]), fallbackId);
	const enabled = enabledValue(payload);
	const description = optionalString(payload.description, "invalid_description", profileId);
	if (description.length > MAX_DESCRIPTION_CHARS) {
		throw new ProfileFileError("description_too_large", profileId);
	}
	const prompt = parsed.body === undefined
		? requiredAliasString(
			payload,
			["system_prompt", "systemPrompt", "instruction", "prompt"],
			"missing_prompt",
			profileId,
		)
		: requiredString(parsed.body, "missing_prompt", profileId);
	if (prompt.length > MAX_PROMPT_CHARS) throw new ProfileFileError("prompt_too_large", profileId);
	const allowedValue = firstDefined(payload, ["allowed_tools", "allowedTools", "tools"]);
	const allowedTools = allowedValue === undefined
		? Object.freeze(["Read"])
		: toolList(allowedValue, "invalid_allowed_tools", profileId, false);
	const deniedValue = firstDefined(payload, [
		"denied_tools",
		"deniedTools",
		"disallowed_tools",
		"disallowedTools",
	]);
	const deniedTools = deniedValue === undefined
		? Object.freeze([])
		: toolList(deniedValue, "invalid_denied_tools", profileId, true);
	const model = optionalString(payload.model, "invalid_model", profileId);
	if (model.length > MAX_MODEL_CHARS) throw new ProfileFileError("model_too_large", profileId);
	return Object.freeze({
		enabled,
		profile: Object.freeze({
			id: profileId,
			description,
			prompt,
			...(model ? { model } : {}),
			allowedTools,
			deniedTools,
			budget: budgetValue(payload, profileId),
			sourceKind: directory.sourceKind,
			sourceDirectory: directory.sourceDirectory,
			fileLabel: path,
		}),
	});
}

async function parsedFile(
	path: string,
	limits: ProfileLimits,
	fallbackId: string,
): Promise<ParsedProfileFile> {
	const fileStats = await stat(path);
	if (!fileStats.isFile()) throw new ProfileFileError("invalid_profile_file", fallbackId);
	if (fileStats.size > limits.maxFileBytes) {
		throw new ProfileFileError("profile_file_too_large", fallbackId);
	}
	const buffer = await readFile(path);
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		throw new ProfileFileError("invalid_utf8", fallbackId);
	}
	if (path.endsWith(".md")) return splitMarkdown(raw, fallbackId);
	try {
		return { payload: recordValue(parseToml(raw), "invalid_toml", fallbackId) };
	} catch (error) {
		if (error instanceof ProfileFileError) throw error;
		throw new ProfileFileError("invalid_toml", fallbackId);
	}
}

function splitMarkdown(raw: string, fallbackId: string): ParsedProfileFile {
	const normalized = raw.replaceAll("\r\n", "\n");
	if (!normalized.startsWith("---\n")) {
		throw new ProfileFileError("missing_frontmatter", fallbackId);
	}
	const closing = normalized.indexOf("\n---\n", 4);
	if (closing < 0) throw new ProfileFileError("missing_frontmatter_end", fallbackId);
	const frontmatter = normalized.slice(4, closing);
	const body = normalized.slice(closing + 5).trim();
	let payload: Readonly<Record<string, unknown>>;
	try {
		payload = recordValue(parseToml(frontmatter), "invalid_frontmatter", fallbackId);
	} catch {
		try {
			payload = recordValue(parseYaml(frontmatter), "invalid_frontmatter", fallbackId);
		} catch {
			throw new ProfileFileError("invalid_frontmatter", fallbackId);
		}
	}
	return { payload, body };
}

function recordForProfile(profile: SubagentProfile, enabled: boolean): SubagentProfileRecord {
	return Object.freeze({
		id: profile.id,
		status: enabled ? "enabled" : "disabled",
		enabled,
		sourceKind: profile.sourceKind,
		sourceDirectory: profile.sourceDirectory,
		fileLabel: profile.fileLabel,
		profile,
		issues: Object.freeze([]),
	});
}

function enabledValue(payload: Readonly<Record<string, unknown>>): boolean {
	if (payload.enabled === undefined) return true;
	if (typeof payload.enabled !== "boolean") {
		throw new ProfileFileError("invalid_enabled", profileIdForError(payload));
	}
	return payload.enabled;
}

function profileIdValue(value: unknown, fallbackId: string): string {
	const selected = value === undefined ? fallbackId : requiredString(value, "invalid_profile_id", fallbackId);
	if (!PROFILE_ID.test(selected)) throw new ProfileFileError("invalid_profile_id", fallbackId);
	return selected;
}

function profileIdForError(payload: Readonly<Record<string, unknown>>): string {
	const value = firstDefined(payload, ["id", "name"]);
	return typeof value === "string" && value.trim() ? value.trim().slice(0, 64) : "profile";
}

function requiredAliasString(
	payload: Readonly<Record<string, unknown>>,
	aliases: readonly string[],
	code: string,
	profileId: string,
): string {
	const value = firstDefined(payload, aliases);
	return requiredString(value, code, profileId);
}

function requiredString(value: unknown, code: string, profileId: string): string {
	if (typeof value !== "string" || !value.trim()) throw new ProfileFileError(code, profileId);
	return value.trim();
}

function optionalString(value: unknown, code: string, profileId: string): string {
	if (value === undefined) return "";
	if (typeof value !== "string") throw new ProfileFileError(code, profileId);
	return value.trim();
}

function toolList(
	value: unknown,
	code: string,
	profileId: string,
	allowEmpty: boolean,
): readonly string[] {
	const raw = typeof value === "string"
		? value.split(",")
		: Array.isArray(value)
			? value
			: undefined;
	if (!raw || raw.length > MAX_TOOLS) throw new ProfileFileError(code, profileId);
	const tools = raw.map((item) => {
		if (typeof item !== "string") throw new ProfileFileError(code, profileId);
		const name = item.trim();
		if (!name || name.length > MAX_TOOL_NAME_CHARS || name.includes("\0")) {
			throw new ProfileFileError(code, profileId);
		}
		return name;
	});
	const unique = [...new Set(tools)];
	if (!allowEmpty && unique.length === 0) throw new ProfileFileError(code, profileId);
	return Object.freeze(unique);
}

function budgetValue(payload: Readonly<Record<string, unknown>>, profileId: string): SubagentBudget {
	const nested = payload.budget;
	if (nested !== undefined && !isRecord(nested)) {
		throw new ProfileFileError("invalid_budget", profileId);
	}
	const budgetPayload = isRecord(nested) ? nested : {};
	const maxTurns = budgetField(payload, budgetPayload, ["maxTurns", "max_turns"], profileId);
	const maxToolCalls = budgetField(
		payload,
		budgetPayload,
		["maxToolCalls", "max_tool_calls"],
		profileId,
	);
	const noProgressTurnLimit = budgetField(
		payload,
		budgetPayload,
		["noProgressTurnLimit", "no_progress_turn_limit"],
		profileId,
	);
	return Object.freeze({
		...(maxTurns === undefined ? {} : { maxTurns }),
		...(maxToolCalls === undefined ? {} : { maxToolCalls }),
		...(noProgressTurnLimit === undefined ? {} : { noProgressTurnLimit }),
	});
}

function budgetField(
	topLevel: Readonly<Record<string, unknown>>,
	nested: Readonly<Record<string, unknown>>,
	aliases: readonly string[],
	profileId: string,
): number | undefined {
	const nestedValue = firstDefined(nested, aliases);
	const value = nestedValue === undefined ? firstDefined(topLevel, aliases) : nestedValue;
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		const suffix = aliases.at(-1) ?? "budget";
		throw new ProfileFileError(`invalid_budget_${suffix}`, profileId);
	}
	return value as number;
}

function firstDefined(
	payload: Readonly<Record<string, unknown>>,
	aliases: readonly string[],
): unknown {
	for (const alias of aliases) {
		if (payload[alias] !== undefined) return payload[alias];
	}
	return undefined;
}

function recordValue(value: unknown, code: string, profileId: string): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) throw new ProfileFileError(code, profileId);
	return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(input: SubagentProfileIssue): SubagentProfileIssue {
	return Object.freeze({
		profileId: input.profileId.slice(0, 64) || "profile",
		sourceKind: input.sourceKind,
		fileLabel: input.fileLabel.slice(0, 128) || "profile",
		errorClass: input.errorClass.slice(0, 64),
	});
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
