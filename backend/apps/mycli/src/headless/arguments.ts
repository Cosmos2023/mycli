import { parseArgs } from "node:util";
import { parseConfigProfileName } from "@mycli/config/profile";
import { HeadlessError, type HeadlessCommand, type ReviewTarget } from "./types.ts";

const DEFAULT_HEADLESS_TIMEOUT_MS = 10 * 60_000;
const MAX_HEADLESS_TIMEOUT_MS = 24 * 60 * 60_000;

export function parseHeadlessCommand(kind: "exec" | "review", args: readonly string[]): HeadlessCommand {
	let parsed;
	try {
		parsed = parseArgs({
			args: [...args], strict: true, allowPositionals: true, tokens: true,
			options: {
				json: { type: "boolean" },
				model: { type: "string" },
				profile: { type: "string", short: "p" },
				timeout: { type: "string" },
				"output-last-message": { type: "string", short: "o" },
				session: { type: "string" },
				"output-schema": { type: "string" },
				uncommitted: { type: "boolean" },
				base: { type: "string" },
				commit: { type: "string" },
			},
		});
	} catch {
		throw new HeadlessError("invalid_headless_arguments", 2);
	}
	const seen = new Set<string>();
	const forbidden = new Set(kind === "exec" ? ["uncommitted", "base", "commit"] : ["session", "output-schema"]);
	for (const token of parsed.tokens) {
		if (token.kind !== "option") continue;
		if (seen.has(token.name) || forbidden.has(token.name) || (typeof token.value === "string" && !token.value.trim())) {
			throw new HeadlessError("invalid_headless_arguments", 2);
		}
		seen.add(token.name);
	}
	const values = parsed.values;
	const timeoutSeconds = values.timeout === undefined ? DEFAULT_HEADLESS_TIMEOUT_MS / 1000 : Number(values.timeout);
	if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_HEADLESS_TIMEOUT_MS / 1000) {
		throw new HeadlessError("invalid_timeout", 2);
	}
	const runtimeArgs: string[] = [];
	for (const name of ["model", "profile", "session"] as const) {
		const value = values[name];
		if (typeof value === "string") {
			if (name === "profile") parseConfigProfileName(value);
			runtimeArgs.push(`--${name}`, value);
		}
	}
	const common = {
		json: values.json === true, timeoutMs: timeoutSeconds * 1000,
		runtimeArgs: Object.freeze(runtimeArgs),
		...(typeof values["output-last-message"] === "string" ? { outputLastMessage: values["output-last-message"] } : {}),
	};
	const prompt = parsed.positionals.join(" ");
	if (kind === "exec") {
		if (parsed.positionals.includes("-") && parsed.positionals.length !== 1) {
			throw new HeadlessError("stdin_prompt_conflict", 2);
		}
		return Object.freeze({ ...common, kind,
			...(prompt ? { prompt } : {}),
			...(typeof values["output-schema"] === "string" ? { outputSchema: values["output-schema"] } : {}),
		});
	}
	const targets = [values.uncommitted, values.base, values.commit].filter((value) => value !== undefined);
	if (targets.length > 1) throw new HeadlessError("review_target_conflict", 2);
	const target: ReviewTarget = typeof values.base === "string" ? { kind: "base", ref: values.base }
		: typeof values.commit === "string" ? { kind: "commit", ref: values.commit } : { kind: "uncommitted" };
	return Object.freeze({ ...common, kind, target: Object.freeze(target), ...(prompt ? { instructions: prompt } : {}) });
}
