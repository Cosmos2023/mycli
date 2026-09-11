#!/usr/bin/env node

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
	BUILTIN_MODEL_CATALOG,
	builtinModelReasoningDefaults,
	modelInputTokenLimit,
	readApiKey,
	resolveProviderProfile,
} from "@mycli/config";
import {
	classifyProviderError,
	ProviderRegistry,
} from "@mycli/providers";

export const CURATED_LIVE_PROVIDER_IDS = Object.freeze([
	"openrouter",
	"groq",
	"together",
	"moonshotai",
	"nvidia",
	"cerebras",
]);

export const SKIP_EXIT_CODE = 77;
const MAX_OUTPUT_TOKENS = 64;
const TIMEOUT_MS = 45_000;
const FIXED_PROMPT = "Reply with exactly OK and no other text.";
const PROVIDER_SET = new Set(CURATED_LIVE_PROVIDER_IDS);

const HELP = `Usage: npm run smoke:providers -- [--provider <id>] [--dry-run] [--evidence <path>]

Options:
  --provider <id>    Curated provider to test; repeat to select more than one
  --dry-run          Report credential readiness without provider traffic
  --evidence <path>  Write the same redacted structural result to a private file
  -h, --help         Show help
`;

export function parseArguments(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			provider: { type: "string", multiple: true },
			"dry-run": { type: "boolean", default: false },
			evidence: { type: "string" },
			help: { type: "boolean", short: "h", default: false },
		},
		strict: true,
		allowPositionals: false,
	});
	const requested = values.provider ?? [];
	if (requested.some((provider) => !PROVIDER_SET.has(provider))) {
		throw new Error("unsupported_provider");
	}
	const providers = requested.length === 0
		? CURATED_LIVE_PROVIDER_IDS
		: CURATED_LIVE_PROVIDER_IDS.filter((provider) => requested.includes(provider));
	return Object.freeze({
		providers: Object.freeze(providers),
		dryRun: values["dry-run"],
		...(values.evidence ? { evidencePath: values.evidence } : {}),
		help: values.help,
	});
}

export async function runCuratedProviderSmoke(options, dependencies = {}) {
	const env = dependencies.env ?? process.env;
	const configuredHome = dependencies.homeDir
		?? env.HOME?.trim()
		?? env.USERPROFILE?.trim();
	const homeDir = configuredHome || homedir();
	const loadStoredApiKey = dependencies.readApiKey ?? readApiKey;
	const createProvider = dependencies.createProvider
		?? ((config) => new ProviderRegistry().create(config));
	const launchApiKey = options.providers.length === 1 ? env.MYCLI_API_KEY?.trim() : undefined;
	const providers = [];

	for (const providerId of options.providers) {
		const profile = resolveProviderProfile(providerId, "chat_completions");
		const entry = BUILTIN_MODEL_CATALOG.find((candidate) =>
			candidate.provider === providerId
			&& candidate.protocol === profile.defaultProtocol
			&& candidate.model === profile.defaultModel);
		if (!entry) {
			providers.push(failedResult(providerId, profile.defaultModel, "config_error"));
			continue;
		}
		const storedApiKey = launchApiKey
			? undefined
			: await loadStoredApiKey({ homeDir, authRef: providerId });
		const apiKey = launchApiKey || storedApiKey;
		const credential = launchApiKey ? "environment" : storedApiKey ? "stored" : "missing";
		if (!apiKey) {
			providers.push(Object.freeze({
				provider: providerId,
				model: entry.model,
				credential,
				status: "skipped",
				checks: emptyChecks(),
			}));
			continue;
		}
		if (options.dryRun) {
			providers.push(Object.freeze({
				provider: providerId,
				model: entry.model,
				credential,
				status: "ready",
				checks: emptyChecks(),
			}));
			continue;
		}

		try {
			const reasoning = builtinModelReasoningDefaults({
				provider: providerId,
				protocol: profile.defaultProtocol,
				model: entry.model,
			});
			const provider = createProvider({
				provider: providerId,
				protocol: profile.defaultProtocol,
				model: entry.model,
				apiBaseUrl: profile.defaultBaseUrl,
				apiKey,
				supportsImages: false,
				maxPromptTokens: modelInputTokenLimit(entry) ?? 12_000,
				...(entry.contextWindowTokens === undefined
					? {}
					: { modelContextWindowTokens: entry.contextWindowTokens }),
				maxOutputTokens: MAX_OUTPUT_TOKENS,
			});
			const events = [];
			for await (const event of provider.stream({
				provider: providerId,
				protocol: profile.defaultProtocol,
				model: entry.model,
				reasoningEffort: reasoning.reasoningEffort,
				instructions: "You are mycli. Complete this fixed provider verification without tools.",
				messages: [{ role: "user", content: FIXED_PROMPT }],
				items: [{ type: "user", text: FIXED_PROMPT }],
				tools: [],
				maxOutputTokens: MAX_OUTPUT_TOKENS,
				sessionId: "curated-provider-smoke",
				cacheRetention: "none",
				webSearchMode: "disabled",
			}, { signal: AbortSignal.timeout(TIMEOUT_MS) })) {
				events.push(event);
			}
			const checks = canonicalProviderChecks(events, providerId, entry.model);
			providers.push(Object.freeze({
				provider: providerId,
				model: entry.model,
				credential,
				status: Object.values(checks).every(Boolean) ? "passed" : "failed",
				checks,
				...(Object.values(checks).every(Boolean) ? {} : { error_code: "provider_error" }),
			}));
		} catch (error) {
			providers.push(failedResult(
				providerId,
				entry.model,
				classifyProviderError(error).code,
				credential,
			));
		}
	}

	const evidence = Object.freeze({
		schema_version: 1,
		status: aggregateStatus(providers, options.dryRun),
		platform: process.platform,
		architecture: process.arch,
		node: process.versions.node,
		providers: Object.freeze(providers),
	});
	if (options.evidencePath) await writeEvidence(options.evidencePath, evidence);
	return Object.freeze({ evidence, exitCode: smokeExitCode(providers) });
}

export function canonicalProviderChecks(events, provider, model) {
	const completionCount = events.filter((event) => event?.type === "completed").length;
	return Object.freeze({
		text: events.some((event) => event?.type === "text_delta"
			&& typeof event.text === "string" && Boolean(event.text.trim())),
		usage: events.some((event) => event?.type === "usage" && validUsage(event.usage)),
		provider_state: events.some((event) => event?.type === "provider_state"
			&& event.state?.provider === provider
			&& event.state?.value?.kind === "pi_ai_assistant"
			&& event.state?.value?.version === 2
			&& event.state?.value?.transport?.routeId === provider
			&& event.state?.value?.transport?.catalogProviderId === provider
			&& event.state?.value?.transport?.model === model),
		completion: completionCount === 1 && events.at(-1)?.type === "completed",
	});
}

function validUsage(usage) {
	return usage !== null
		&& typeof usage === "object"
		&& !Array.isArray(usage)
		&& Object.keys(usage).length > 0
		&& Object.values(usage).every((value) =>
			typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function emptyChecks() {
	return Object.freeze({ text: false, usage: false, provider_state: false, completion: false });
}

function failedResult(provider, model, errorCode, credential = "unknown") {
	return Object.freeze({
		provider,
		model,
		credential,
		status: "failed",
		checks: emptyChecks(),
		error_code: errorCode,
	});
}

function aggregateStatus(providers, dryRun) {
	if (providers.some((provider) => provider.status === "failed")) return "failed";
	if (dryRun && providers.some((provider) => provider.status === "ready")) return "ready";
	const passed = providers.filter((provider) => provider.status === "passed").length;
	if (passed === providers.length) return "passed";
	if (passed > 0) return "partial";
	return "skipped";
}

function smokeExitCode(providers) {
	if (providers.some((provider) => provider.status === "failed")) return 1;
	if (providers.some((provider) => provider.status === "passed" || provider.status === "ready")) {
		return 0;
	}
	return SKIP_EXIT_CODE;
}

async function writeEvidence(path, evidence) {
	const target = resolve(path);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await chmod(target, 0o600);
}

async function main() {
	let options;
	try {
		options = parseArguments(process.argv.slice(2));
	} catch {
		process.stderr.write("provider_smoke_usage_error: use --provider with a curated provider id\n");
		return 64;
	}
	if (options.help) {
		process.stdout.write(HELP);
		return 0;
	}
	const result = await runCuratedProviderSmoke(options);
	process.stdout.write(`${JSON.stringify(result.evidence)}\n`);
	return result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((exitCode) => { process.exitCode = exitCode; }).catch(() => {
		process.stdout.write(`${JSON.stringify({
			schema_version: 1,
			status: "failed",
			providers: [],
		})}\n`);
		process.exitCode = 1;
	});
}
