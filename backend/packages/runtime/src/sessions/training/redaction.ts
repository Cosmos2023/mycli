const MASK = "[REDACTED]";
const SECRET_NAME = "(?:[a-z][\\w.-]{0,127}[_-])?(?:api[_-]?key|(?:access|refresh|auth|session)[_-]?token|token|secret|password|passwd|authorization|cookie|private[_-]?key)";
const ASSIGNMENT = new RegExp(`(\\b${SECRET_NAME}["']?\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'[^']*'|\\[REDACTED\\]|[^\\s,;}&\\]]+)`, "giu");
const SECRET_FLAG = new RegExp(`(--${SECRET_NAME}(?:=|[ \\t]+))("(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s;]+)`, "giu");

export function isTrainingSecretKey(key: string): boolean {
	return /(?:^|[_-])(?:api[_-]?key|(?:access|refresh|auth|session)[_-]?token|token|secret|password|passwd|authorization|cookie|private[_-]?key|credentials?)$/iu.test(key)
		|| /^(?:apiKey|accessToken|refreshToken|authToken|sessionToken|privateKey|clientSecret)$/iu.test(key);
}

export interface TrainingRedactionOptions {
	readonly secrets?: readonly string[];
	readonly paths?: readonly { readonly path: string; readonly replacement: string }[];
}

/** Scoped to training artifacts: keep multiline text and schema property names intact. */
export class TrainingRedactor {
	#count = 0;
	readonly #secrets: readonly string[];
	readonly #paths: readonly { readonly path: string; readonly replacement: string }[];

	constructor(options: TrainingRedactionOptions = {}) {
		this.#secrets = [...new Set(options.secrets?.filter((value) => value.length > 0))]
			.sort((a, b) => b.length - a.length);
		this.#paths = [...(options.paths ?? [])].filter((entry) => entry.path.length > 1)
			.sort((a, b) => b.path.length - a.path.length);
	}

	get count(): number { return this.#count; }

	text(value: string): string {
		let result = value;
		for (const secret of this.#secrets) {
			result = result.replaceAll(secret, () => this.#mask(secret));
		}
		result = result
			.replace(/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/gu, (match) => this.#mask(match))
			.replace(/\b(?:Bearer|Basic)[ \t]+(?:\[REDACTED\]|[A-Za-z0-9+/_.=~%-]+)/giu, (match) => this.#mask(match))
			.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b/gu, (match) => this.#mask(match))
			.replace(/\b([a-z][a-z\d+.-]{0,31}:\/\/)[^\s/:@]+(?::[^\s/@]*)?@/giu, (_match, protocol: string) => `${protocol}${this.#mask("credentials")}@`)
			.replace(ASSIGNMENT, (_match, prefix: string, secret: string) => `${prefix}${this.#quotedMask(secret)}`)
			.replace(SECRET_FLAG, (_match, prefix: string, secret: string) => `${prefix}${this.#quotedMask(secret)}`);
		for (const { path, replacement } of this.#paths) {
			result = result.replaceAll(path, () => {
				this.#count += 1;
				return replacement;
			});
		}
		return result;
	}

	json(value: unknown, sensitive = false): unknown {
		if (value === null) return null;
		if (Array.isArray(value)) return value.map((entry: unknown) => this.json(entry, sensitive));
		if (typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
				key, this.json(entry, sensitive || isTrainingSecretKey(key)),
			]));
		}
		if (sensitive) return this.#mask(String(value));
		return typeof value === "string" ? this.text(value) : value;
	}

	schema(value: Readonly<Record<string, unknown>>, sensitive = false): Readonly<Record<string, unknown>> {
		return Object.fromEntries(Object.entries(value).map(([key, entry]): [string, unknown] => {
			if (["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key) && isRecord(entry)) {
				return [key, Object.fromEntries(Object.entries(entry).map(([name, schema]) => [name,
					isRecord(schema) ? this.schema(schema, sensitive || isTrainingSecretKey(name)) : schema,
				]))];
			}
			if (["default", "examples", "example", "const", "enum"].includes(key)) return [key, this.json(entry, sensitive)];
			if (isRecord(entry)) return [key, this.schema(entry, sensitive)];
			if (Array.isArray(entry)) return [key, entry.map((item: unknown) => isRecord(item)
				? this.schema(item, sensitive) : this.json(item))];
			return [key, typeof entry === "string" ? this.text(entry) : entry];
		}));
	}

	#quotedMask(value: string): string {
		const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
		return `${quote}${this.#mask(value)}${quote}`;
	}

	#mask(value: string): string {
		if (!value.includes(MASK)) this.#count += 1;
		return MASK;
	}
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
