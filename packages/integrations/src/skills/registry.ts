import { basename, join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type {
	SkillDefinition,
	SkillDiagnosticIssue,
	SkillRegistryDiagnostics,
	SkillSourceKind,
} from "./types.ts";

export interface SkillRegistryOptions {
	readonly builtinRoot: string;
	readonly userRoot: string;
	readonly sharedRepoRoot?: string;
	readonly repoRoot?: string;
	readonly maxFileBytes?: number;
	readonly maxFrontmatterChars?: number;
	readonly maxBodyChars?: number;
	readonly maxSkills?: number;
}

interface SkillDirectory {
	readonly root: string;
	readonly sourceKind: SkillSourceKind;
}

interface ParsedSkillFile {
	readonly payload: Readonly<Record<string, unknown>>;
	readonly body: string;
}

const DEFAULT_MAX_FILE_BYTES = 131_072;
const DEFAULT_MAX_FRONTMATTER_CHARS = 16_384;
const DEFAULT_MAX_BODY_CHARS = 65_536;
const DEFAULT_MAX_SKILLS = 256;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_HINTS = 32;
const MAX_HINT_CHARS = 160;
const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

class SkillFileError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

export class SkillRegistry {
	readonly #skills: ReadonlyMap<string, SkillDefinition>;
	readonly #diagnostics: SkillRegistryDiagnostics;

	private constructor(
		skills: ReadonlyMap<string, SkillDefinition>,
		diagnostics: SkillRegistryDiagnostics,
	) {
		this.#skills = skills;
		this.#diagnostics = diagnostics;
	}

	static async discover(options: SkillRegistryOptions): Promise<SkillRegistry> {
		const limits = resolveLimits(options);
		const directories: SkillDirectory[] = [
			{ root: options.builtinRoot, sourceKind: "builtin" },
			{ root: options.userRoot, sourceKind: "user" },
			...(options.sharedRepoRoot
				? [{ root: options.sharedRepoRoot, sourceKind: "shared_repo" as const }]
				: []),
			...(options.repoRoot
				? [{ root: options.repoRoot, sourceKind: "repo" as const }]
				: []),
		];
		const skills = new Map<string, SkillDefinition>();
		const duplicateNames = new Set<string>();
		const issues: SkillDiagnosticIssue[] = [];
		let discoveredCount = 0;

		for (const directory of directories) {
			let paths: readonly string[];
			try {
				paths = await skillPaths(directory.root);
			} catch {
				issues.push(issue(directory.sourceKind, basename(directory.root), "directory_read_failed"));
				continue;
			}
			for (const path of paths) {
				discoveredCount += 1;
				if (discoveredCount > limits.maxSkills) {
					issues.push(issue(directory.sourceKind, basename(path), "skill_limit_exceeded"));
					continue;
				}
				try {
					const definition = await parseSkill(path, directory.sourceKind, limits);
					if (skills.has(definition.name)) duplicateNames.add(definition.name);
					skills.set(definition.name, definition);
				} catch (error) {
					issues.push(issue(
						directory.sourceKind,
						basename(path),
						error instanceof SkillFileError ? error.code : "skill_read_failed",
					));
				}
			}
		}

		const sourceCounts = {
			builtin: 0,
			user: 0,
			shared_repo: 0,
			repo: 0,
		} satisfies Record<SkillSourceKind, number>;
		for (const definition of skills.values()) sourceCounts[definition.sourceKind] += 1;
		const diagnostics: SkillRegistryDiagnostics = Object.freeze({
			directoryCount: directories.length,
			discoveredCount,
			loadedCount: skills.size,
			duplicateCount: duplicateNames.size,
			issueCount: issues.length,
			sourceCounts: Object.freeze(sourceCounts),
			issues: Object.freeze(issues),
		});
		return new SkillRegistry(skills, diagnostics);
	}

	get(name: string): SkillDefinition | undefined {
		const normalized = tryNormalizeSkillName(name);
		return normalized ? this.#skills.get(normalized) : undefined;
	}

	list(): readonly SkillDefinition[] {
		return Object.freeze([...this.#skills.values()].sort((left, right) => compareText(
			left.name,
			right.name,
		)));
	}

	diagnostics(): SkillRegistryDiagnostics {
		return this.#diagnostics;
	}
}

interface ResolvedLimits {
	readonly maxFileBytes: number;
	readonly maxFrontmatterChars: number;
	readonly maxBodyChars: number;
	readonly maxSkills: number;
}

function resolveLimits(options: SkillRegistryOptions): ResolvedLimits {
	return {
		maxFileBytes: positiveBound(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1_048_576),
		maxFrontmatterChars: positiveBound(
			options.maxFrontmatterChars,
			DEFAULT_MAX_FRONTMATTER_CHARS,
			65_536,
		),
		maxBodyChars: positiveBound(options.maxBodyChars, DEFAULT_MAX_BODY_CHARS, 65_536),
		maxSkills: positiveBound(options.maxSkills, DEFAULT_MAX_SKILLS, 1_024),
	};
}

function positiveBound(value: number | undefined, fallback: number, maximum: number): number {
	const selected = value ?? fallback;
	if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
		throw new Error("invalid_skill_registry_limit");
	}
	return selected;
}

async function skillPaths(root: string): Promise<readonly string[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	const sorted = [...entries].sort((left, right) => compareText(left.name, right.name));
	const flat = sorted
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => join(root, entry.name));
	const nested = sorted
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name, "SKILL.md"));
	const existingNested: string[] = [];
	for (const path of nested) {
		try {
			if ((await stat(path)).isFile()) existingNested.push(path);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}
	return Object.freeze([...flat, ...existingNested]);
}

async function parseSkill(
	path: string,
	sourceKind: SkillSourceKind,
	limits: ResolvedLimits,
): Promise<SkillDefinition> {
	const fileStats = await stat(path);
	if (!fileStats.isFile()) throw new SkillFileError("invalid_skill_file");
	if (fileStats.size > limits.maxFileBytes) throw new SkillFileError("skill_file_too_large");
	const buffer = await readFile(path);
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		throw new SkillFileError("invalid_utf8");
	}
	const parsed = splitSkillFile(raw, limits);
	const name = normalizeSkillName(parsed.payload.name);
	const description = requiredString(parsed.payload.description, "missing_description");
	if (description.length > MAX_DESCRIPTION_CHARS) {
		throw new SkillFileError("description_too_large");
	}
	return Object.freeze({
		name,
		description,
		triggerHints: stringList(parsed.payload.trigger_hints),
		envDependencies: stringList(parsed.payload.env_dependencies),
		workspaceDependencies: stringList(parsed.payload.workspace_dependencies),
		guardrails: stringList(parsed.payload.guardrails),
		body: parsed.body,
		sourceKind,
		fileLabel: basename(path).slice(0, 128),
	});
}

function splitSkillFile(raw: string, limits: ResolvedLimits): ParsedSkillFile {
	const normalized = raw.replaceAll("\r\n", "\n");
	if (!normalized.startsWith("---\n")) throw new SkillFileError("missing_frontmatter");
	const closing = normalized.indexOf("\n---\n", 4);
	if (closing < 0) throw new SkillFileError("missing_frontmatter_end");
	const frontmatter = normalized.slice(4, closing);
	const body = normalized.slice(closing + 5).trim();
	if (frontmatter.length > limits.maxFrontmatterChars) {
		throw new SkillFileError("skill_frontmatter_too_large");
	}
	if (body.length > limits.maxBodyChars) throw new SkillFileError("skill_body_too_large");
	return { payload: parseFrontmatter(frontmatter), body };
}

function parseFrontmatter(frontmatter: string): Readonly<Record<string, unknown>> {
	try {
		return recordValue(parseToml(frontmatter));
	} catch {
		try {
			return recordValue(parseYaml(frontmatter));
		} catch {
			throw new SkillFileError("invalid_frontmatter");
		}
	}
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SkillFileError("invalid_frontmatter");
	}
	return value as Readonly<Record<string, unknown>>;
}

function normalizeSkillName(value: unknown): string {
	if (typeof value !== "string") throw new SkillFileError("missing_name");
	const normalized = value.trim().toLowerCase();
	if (!SKILL_NAME.test(normalized) || normalized.includes("/") || normalized.includes("\\")) {
		throw new SkillFileError("invalid_name");
	}
	return normalized;
}

function tryNormalizeSkillName(value: string): string | undefined {
	try {
		return normalizeSkillName(value);
	} catch {
		return undefined;
	}
}

function requiredString(value: unknown, code: string): string {
	if (typeof value !== "string" || !value.trim()) throw new SkillFileError(code);
	return value.trim().replace(/\s+/gu, " ");
}

function stringList(value: unknown): readonly string[] {
	if (value === undefined) return Object.freeze([]);
	if (!Array.isArray(value) || value.length > MAX_HINTS) {
		throw new SkillFileError("invalid_skill_metadata");
	}
	const result = value.map((item) => {
		if (typeof item !== "string" || !item.trim() || item.length > MAX_HINT_CHARS) {
			throw new SkillFileError("invalid_skill_metadata");
		}
		return item.trim().replace(/\s+/gu, " ");
	});
	return Object.freeze(result);
}

function issue(
	sourceKind: SkillSourceKind,
	fileLabel: string,
	errorClass: string,
): SkillDiagnosticIssue {
	return Object.freeze({
		sourceKind,
		fileLabel: fileLabel.slice(0, 128) || "skill",
		errorClass: errorClass.slice(0, 64),
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
