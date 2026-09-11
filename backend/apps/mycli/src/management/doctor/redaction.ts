import { open } from "node:fs/promises";
import { basename, relative } from "node:path";

const REDACTED = "[REDACTED]";
const MAX_VALUE_DEPTH = 8;
const MAX_ARRAY_ITEMS = 64;
const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_FILE_BYTES = 1_048_576;
const DEFAULT_MAX_REFERENCES = 64;

const SECRET_FIELD_KEY = /(?:^|[_-])(?:api[-_]?key|authorization|cookie|password|secret|token|credential)(?:$|[_-])/iu;
const SECRET_CONTAINER_KEY = /^(?:headers?|env(?:ironment)?)$/iu;
const SENSITIVE_TEXT = /(?:\bBearer\s+[^\s,;]+|\bsk-[A-Za-z0-9_-]{8,}|\b(?:api[-_]?key|token|secret|password|authorization|credential)\b\s*(?:=|:)\s*[^\s,;]+)/iu;

interface DoctorFileScanOptions {
	readonly root: string;
	readonly paths: readonly string[];
	readonly maxFiles?: number;
	readonly maxFileBytes?: number;
	readonly maxReferences?: number;
}

interface DoctorFileScan {
	readonly scannedFileCount: number;
	readonly findingCount: number;
	readonly unreadableCount: number;
	readonly truncated: boolean;
	readonly references: readonly string[];
}

export function redactDoctorText(value: string): string {
	let redacted = stripControlCharacters(value);
	redacted = redacted.replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/giu, REDACTED);
	redacted = redacted.replace(/\bBearer\s+[^\s,;]+/giu, REDACTED);
	redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, REDACTED);
	redacted = redacted.replace(
		/\b(?:api[-_]?key|token|secret|password|credential)\b\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
		(match) => /^api[-_]?key\s*(?:=|:)\s*(?:present|missing|unknown)$/iu.test(match)
			? match
			: REDACTED,
	);
	redacted = redacted.replace(
		/(?:--)?(?:api[-_]?key|token|secret|password|credential)\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
		REDACTED,
	);
	redacted = redacted.replace(
		/\b(?:headers?|env(?:ironment)?|command|args?|argv|prompt|provider[-_]?payload|request[-_]?payload|response[-_]?payload|stdout|stderr|content)\b\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|\[[^\]]*\]|\{[^}]*\}|[^\s,;]+)/giu,
		REDACTED,
	);
	return redacted.replace(/\s+/gu, " ").trim();
}

function stripControlCharacters(value: string): string {
	return [...value].map((character) => {
		const code = character.charCodeAt(0);
		const permittedWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
		return (code < 0x20 && !permittedWhitespace) || code === 0x7f ? " " : character;
	}).join("");
}

export async function scanDoctorFiles(options: DoctorFileScanOptions): Promise<DoctorFileScan> {
	const maxFiles = positiveLimit(options.maxFiles, DEFAULT_MAX_FILES, 512);
	const maxFileBytes = positiveLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 8_388_608);
	const maxReferences = positiveLimit(options.maxReferences, DEFAULT_MAX_REFERENCES, 512);
	const paths = [...new Set(options.paths)].slice(0, maxFiles);
	const references: string[] = [];
	let findingCount = 0;
	let unreadableCount = 0;
	let truncated = options.paths.length > paths.length;

	for (const path of paths) {
		let content: string;
		try {
			const read = await readPrefix(path, maxFileBytes);
			content = read.content;
			truncated ||= read.truncated;
		} catch {
			unreadableCount += 1;
			continue;
		}
		const label = safeRelativeLabel(options.root, path);
		for (const [index, line] of content.split(/\r?\n/u).entries()) {
			if (!line) continue;
			const jsonFindings = jsonSecretPaths(line);
			if (jsonFindings) {
				findingCount += jsonFindings.length;
				for (const jsonPath of jsonFindings) {
					if (references.length < maxReferences) {
						references.push(`${label}:${index + 1}:${jsonPath}`);
					} else {
						truncated = true;
					}
				}
			} else if (SENSITIVE_TEXT.test(line)) {
				findingCount += 1;
				if (references.length < maxReferences) references.push(`${label}:${index + 1}`);
				else truncated = true;
			}
		}
	}

	return Object.freeze({
		scannedFileCount: paths.length - unreadableCount,
		findingCount,
		unreadableCount,
		truncated,
		references: Object.freeze(references),
	});
}

async function readPrefix(
	path: string,
	maxBytes: number,
): Promise<{ readonly content: string; readonly truncated: boolean }> {
	const handle = await open(path, "r");
	try {
		const stats = await handle.stat();
		const length = Math.min(stats.size, maxBytes);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return {
			content: buffer.subarray(0, bytesRead).toString("utf8"),
			truncated: stats.size > maxBytes,
		};
	} finally {
		await handle.close();
	}
}

function jsonSecretPaths(line: string): readonly string[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	const findings: string[] = [];
	visitJson(parsed, "$", 0, findings, false);
	return findings;
}

function visitJson(
	value: unknown,
	path: string,
	depth: number,
	findings: string[],
	secretContainer: boolean,
): void {
	if (depth >= MAX_VALUE_DEPTH || findings.length >= DEFAULT_MAX_REFERENCES) return;
	if (typeof value === "string") {
		if ((secretContainer && !isRedactedMarker(value)) || SENSITIVE_TEXT.test(value)) {
			findings.push(path);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.slice(0, MAX_ARRAY_ITEMS).entries()) {
			visitJson(item, `${path}[${index}]`, depth + 1, findings, secretContainer);
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, item] of Object.entries(value).slice(0, MAX_ARRAY_ITEMS)) {
		const next = `${path}.${safeJsonKey(key)}`;
		if (SECRET_FIELD_KEY.test(key) && !isRedactedMarker(item)) findings.push(next);
		else visitJson(
			item,
			next,
			depth + 1,
			findings,
			secretContainer || SECRET_CONTAINER_KEY.test(key),
		);
	}
}

function isRedactedMarker(value: unknown): boolean {
	return typeof value === "string" && /^(?:\[REDACTED\]|redacted|present|missing|unknown)$/iu.test(value.trim());
}

function safeJsonKey(value: string): string {
	return /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(value) ? value : "field";
}

function safeRelativeLabel(root: string, path: string): string {
	const candidate = relative(root, path).replaceAll("\\", "/");
	if (!candidate || candidate === ".." || candidate.startsWith("../")) {
		return basename(path).slice(0, 128) || "diagnostic";
	}
	return candidate.split("/").map((part) => basename(part).slice(0, 128)).join("/");
}

function positiveLimit(value: number | undefined, fallback: number, maximum: number): number {
	const selected = value ?? fallback;
	if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
		throw new RangeError("invalid_doctor_scan_limit");
	}
	return selected;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
