import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import ts from "typescript";
import { loadPiAiProviderDirectory } from "../../src/registry/provider-directory.ts";
import type { ProviderDirectoryStatus } from "../../src/registry/provider-directory-types.ts";

export const REVIEWED_PI_AI_VERSION = "0.84.4";

interface AdapterHooks {
	readonly fetch: "supported" | "rejected" | "ignored" | "sse_only";
	readonly onResponse: "supported" | "absent" | "sse_only";
	readonly limitation?: string;
}

// Reviewed against the pinned concrete adapter implementations, not API name similarity.
const ADAPTER_HOOKS: Readonly<Record<string, AdapterHooks>> = Object.freeze({
	"anthropic-messages": { fetch: "supported", onResponse: "supported" },
	"openai-completions": { fetch: "supported", onResponse: "supported" },
	"openai-responses": { fetch: "supported", onResponse: "supported" },
	"azure-openai-responses": { fetch: "supported", onResponse: "supported", limitation: "Azure endpoint/deployment configuration" },
	"google-generative-ai": { fetch: "rejected", onResponse: "absent", limitation: "custom fetch explicitly rejected" },
	"google-vertex": { fetch: "rejected", onResponse: "absent", limitation: "custom fetch rejected; native Google auth context" },
	"bedrock-converse-stream": { fetch: "ignored", onResponse: "supported", limitation: "AWS transport/auth; metadata middleware only" },
	"mistral-conversations": { fetch: "supported", onResponse: "supported", limitation: "native conversation protocol not enabled" },
	"openai-codex-responses": { fetch: "sse_only", onResponse: "sse_only", limitation: "OAuth; WebSocket path needs separate observation" },
	"pi-messages": { fetch: "supported", onResponse: "supported", limitation: "dynamic catalog requires native configuration refresh" },
});

export interface BuiltinProviderInventoryRow {
	readonly provider: string;
	readonly modelApis: readonly string[];
	readonly implementations: readonly string[];
	readonly sdkAuth: readonly string[];
	readonly status: ProviderDirectoryStatus;
	readonly activationReason: string;
	readonly hooks: readonly string[];
	readonly wrapper: string;
}

export async function builtinProviderInventory(): Promise<readonly BuiltinProviderInventoryRow[]> {
	const directory = await loadPiAiProviderDirectory();
	const sdkRoot = new URL("./", import.meta.resolve("@earendil-works/pi-ai"));
	const rows: BuiltinProviderInventoryRow[] = [];
	for (const provider of builtinProviders()) {
		const entry = directory.providers.find((candidate) => candidate.catalogProviderId === provider.id);
		if (!entry) throw new Error(`Missing directory disposition: ${provider.id}`);
		const sourceUrl = new URL(`providers/${provider.id}.js`, sdkRoot);
		const source = ts.createSourceFile(fileURLToPath(sourceUrl), await readFile(sourceUrl, "utf8"),
			ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
		const imports = source.statements.flatMap((statement) =>
			ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
				? [statement.moduleSpecifier.text] : []);
		const adapters = imports.filter((path) => path.startsWith("../api/") && path.endsWith(".lazy.js"))
			.map((path) => path.slice("../api/".length, -".lazy.js".length)).sort();
		if (adapters.length === 0) throw new Error(`Unreviewed provider implementation: ${provider.id}`);
		const hooks = adapters.map((adapter) => {
			const reviewed = ADAPTER_HOOKS[adapter];
			if (!reviewed) throw new Error(`Unreviewed adapter hooks: ${adapter}`);
			return `${adapter}: fetch=${reviewed.fetch}, onResponse=${reviewed.onResponse}`;
		});
		rows.push({
			provider: provider.id,
			modelApis: [...new Set(provider.getModels().map((model) => model.api))].sort(),
			implementations: adapters.map((adapter) => `api/${adapter}.js`),
			sdkAuth: [
				...(provider.auth.apiKey ? [`apiKey (${provider.auth.apiKey.name})`] : []),
				...(provider.auth.oauth ? ["oauth"] : []),
			],
			status: entry.status,
			activationReason: entry.disabledReason ?? ([
				...(entry.endpointRequired ? ["endpoint_required"] : []),
				...(entry.protocols.length > 1 ? ["protocol_selection_required"] : []),
			].join(", ") || "request_api_key"),
			hooks,
			wrapper: imports.includes("./cloudflare-stream.js") ? "cloudflareStreams endpoint env substitution"
				: provider.id === "radius" ? "dynamic catalog refresh"
					: "createProvider API dispatch",
		});
	}
	return rows.sort((left, right) => left.provider.localeCompare(right.provider, "en"));
}

export function renderBuiltinProviderInventory(rows: readonly BuiltinProviderInventoryRow[]): string {
	return [
		"| Provider | Model APIs | Concrete SDK Adapter | SDK Auth | Current Disposition | Hooks |",
		"| --- | --- | --- | --- | --- | --- |",
		...rows.map((row) => `| ${row.provider} | ${row.modelApis.join(", ") || "none (dynamic)"} | ${row.implementations.join(", ")}; ${row.wrapper} | ${row.sdkAuth.join(", ")} | ${row.status}: ${row.activationReason} | ${row.hooks.join("; ")} |`),
	].join("\n");
}

export function reviewedAdapterLimitations(): readonly string[] {
	return Object.entries(ADAPTER_HOOKS).flatMap(([adapter, hooks]) =>
		hooks.limitation === undefined ? [] : [`${adapter}: ${hooks.limitation}`]);
}
