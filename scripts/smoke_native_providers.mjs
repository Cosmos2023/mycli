#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "@mycli/config";
import { parseProviderRouteId } from "@mycli/core";
import {
	captureProviderNativeEnvironment,
	classifyProviderError,
	inspectNativeProviderAuth,
	loadPiAiProviderDirectory,
	ProviderRegistry,
	resolveProviderNativeTransport,
} from "@mycli/providers";
import { canonicalProviderChecks, SKIP_EXIT_CODE } from "./smoke_curated_providers.mjs";

export function parseArguments(argv) {
	const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
		provider: { type: "string" }, model: { type: "string" }, protocol: { type: "string" },
		live: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false },
	} });
	if (!values.help) parseProviderRouteId(values.provider);
	return Object.freeze(values);
}

export async function runNativeProviderSmoke(options, dependencies = {}) {
	const providerId = parseProviderRouteId(options.provider);
	const environment = dependencies.env ?? process.env;
	const homeDir = dependencies.homeDir ?? environment.HOME ?? environment.USERPROFILE ?? homedir();
	const evidence = { schema_version: 1, provider: providerId, live_requested: options.live === true, live_validated: false };
	try {
		const entry = (await loadPiAiProviderDirectory()).providers.find((provider) => provider.catalogProviderId === providerId);
		if (!entry || entry.status === "unsupported") {
			return outcome({ ...evidence, status: "skipped", reason: entry?.disabledReason ?? "unknown_provider" });
		}
		const config = await resolveConfig({ homeDir, workspaceRoot: dependencies.cwd ?? process.cwd(), env: environment, overrides: {
			provider: providerId, ...(options.model ? { model: options.model } : {}),
			...(options.protocol ? { protocol: options.protocol } : {}),
		} });
		const nativeTransport = await resolveProviderNativeTransport({ catalogProviderId: providerId, modelId: config.model,
			protocol: config.protocol, apiBaseUrl: config.apiBaseUrl, environment, allowDeclaredModel: true });
		const providerEnv = await captureProviderNativeEnvironment({ catalogProviderId: providerId, environment,
			...(config.apiKey ? { apiKey: config.apiKey } : {}) });
		const auth = config.apiKey ? { configured: true, credentialType: "api_key", source: "configured" }
			: await inspectNativeProviderAuth({ provider: providerId, homeDir, authRef: config.authRef,
				providerEnv, allowAmbientAuth: config.allowAmbientAuth });
		Object.assign(evidence, { model: config.model, native_api: nativeTransport.api,
			credential_type: auth.credentialType ?? "missing", credential_source: auth.source });
		if (!auth.configured) return outcome({ ...evidence, status: "skipped", reason: "missing_credentials" });
		if (!options.live) return outcome({ ...evidence, status: "ready" });
		const provider = new ProviderRegistry(dependencies.fetch ? { fetch: dependencies.fetch } : {}).create({
			...config, homeDir, nativeTransport, providerEnv, supportsImages: false, maxOutputTokens: 4096,
		});
		const levels = (await provider.resolveCapabilities?.())?.reasoningEfforts;
		const reasoningEffort = !levels || levels.includes("none") ? "none" : levels[0] ?? "none";
		const events = [];
		for await (const event of provider.stream({
			provider: providerId, model: config.model, protocol: config.protocol, nativeTransport,
			instructions: "Complete this fixed provider verification without tools.",
			messages: [{ role: "user", content: "Reply with exactly OK and no other text." }],
			tools: [], reasoningEffort, maxOutputTokens: reasoningEffort === "none" ? 128 : 4096,
			cacheRetention: "none", webSearchMode: "disabled",
		}, { signal: AbortSignal.timeout(45_000) })) events.push(event);
		const checks = canonicalProviderChecks(events, providerId, config.model);
		const passed = Object.values(checks).every(Boolean);
		return outcome({ ...evidence, status: passed ? "passed" : "failed", live_validated: passed, checks });
	} catch (error) {
		return outcome({ ...evidence, status: "failed", error_code: classifyProviderError(error).code });
	}
}

function outcome(evidence) {
	return Object.freeze({ evidence: Object.freeze(evidence), exitCode: evidence.status === "failed" ? 1
		: evidence.status === "skipped" ? SKIP_EXIT_CODE : 0 });
}

async function main() {
	let options;
	try { options = parseArguments(process.argv.slice(2)); }
	catch { process.stderr.write("provider_smoke_usage_error: --provider <catalog-id> is required\n"); return 64; }
	if (options.help) {
		process.stdout.write("Usage: npm run smoke:providers:native -- --provider <id> [--model <id>] [--protocol <id>] [--live]\nDefaults to local credential checks. --live sends one fixed request; missing credentials exit 77.\n");
		return 0;
	}
	const result = await runNativeProviderSmoke(options);
	process.stdout.write(`${JSON.stringify(result.evidence)}\n`);
	return result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
