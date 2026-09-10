import { createHash } from "node:crypto";
import { isProviderRouteId } from "../types.ts";
import type { ProtocolId, ProviderRouteId } from "../types.ts";

export const PROVIDER_NATIVE_APIS = Object.freeze([
	"openai-responses", "openai-completions", "anthropic-messages", "azure-openai-responses",
] as const);

export type ProviderNativeApi = typeof PROVIDER_NATIVE_APIS[number];

export interface ProviderNativeTransportSnapshot {
	readonly version: 1;
	readonly catalogProviderId: ProviderRouteId;
	readonly api: ProviderNativeApi;
	readonly modelId: string;
	readonly modelSource: "catalog" | "declared";
	readonly endpointSha256: string;
	readonly azure?: Readonly<{ readonly apiVersion: string; readonly deploymentName: string }>;
}

export function parseProviderNativeTransportSnapshot(value: unknown): ProviderNativeTransportSnapshot {
	const record = object(value);
	const keys = ["version", "catalogProviderId", "api", "modelId", "endpointSha256",
		...(record.modelSource === undefined ? [] : ["modelSource"]), ...(record.azure === undefined ? [] : ["azure"])];
	if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))
		|| record.version !== 1 || !isProviderRouteId(record.catalogProviderId)
		|| !PROVIDER_NATIVE_APIS.includes(record.api as ProviderNativeApi)
		|| typeof record.endpointSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.endpointSha256)) throw invalid();
	const api = record.api as ProviderNativeApi;
	if (record.modelSource !== undefined && record.modelSource !== "catalog" && record.modelSource !== "declared") throw invalid();
	let azure: ProviderNativeTransportSnapshot["azure"];
	if (api === "azure-openai-responses") {
		const fields = object(record.azure);
		if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, "apiVersion")
			|| !Object.hasOwn(fields, "deploymentName")) throw invalid();
		const apiVersion = text(fields.apiVersion, 64);
		const deploymentName = text(fields.deploymentName, 256);
		if (!/^[A-Za-z0-9._-]+$/u.test(apiVersion) || !/^[A-Za-z0-9._-]+$/u.test(deploymentName)) throw invalid();
		azure = Object.freeze({ apiVersion, deploymentName });
	} else if (record.azure !== undefined) throw invalid();
	return Object.freeze({ version: 1, catalogProviderId: record.catalogProviderId,
		api, modelId: text(record.modelId, 512), modelSource: record.modelSource ?? "catalog", endpointSha256: record.endpointSha256,
		...(azure ? { azure } : {}),
	});
}

export function providerNativeProtocol(api: ProviderNativeApi): ProtocolId {
	switch (api) {
		case "openai-responses":
		case "azure-openai-responses": return "responses";
		case "openai-completions": return "chat_completions";
		case "anthropic-messages": return "anthropic_messages";
	}
}

export function providerNativeEndpointSha256(value: string): string {
	let url: URL;
	try { url = new URL(text(value, 2048)); } catch { throw invalid(); }
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password
		|| url.search || url.hash) throw invalid();
	return createHash("sha256").update(`${url.origin}${url.pathname.replace(/\/+$/u, "")}`).digest("hex");
}

function object(value: unknown): Readonly<Record<string, unknown>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, limit: number): string {
	if (typeof value !== "string" || !value || value.length > limit || value.trim() !== value
		|| [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw invalid();
	return value;
}

function invalid(): TypeError { return new TypeError("invalid provider native transport snapshot"); }
