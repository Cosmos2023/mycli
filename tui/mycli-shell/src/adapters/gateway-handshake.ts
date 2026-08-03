import { gatewayContractCatalog } from "@mycli/contracts";

export const GATEWAY_PROTOCOL_VERSION = 1;
export const GATEWAY_MANIFEST_SCHEMA_VERSION = 1;

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const MIN_STARTUP_TIMEOUT_MS = 1_000;
const MAX_STARTUP_TIMEOUT_MS = 60_000;

export function verifyGatewayManifest(value: unknown): void {
	if (!isRecord(value) || value.schema_version !== GATEWAY_MANIFEST_SCHEMA_VERSION) {
		throw new Error("incompatible_protocol: unsupported gateway manifest schema");
	}
	const rpcMethods = entryNames(value.rpc_methods);
	const missingRpcMethods = gatewayContractCatalog.rpcMethods.filter(
		(name) => !rpcMethods.has(name),
	);
	if (missingRpcMethods.length > 0) {
		throw new Error(`missing_rpc_methods: count=${missingRpcMethods.length}`);
	}
	const eventStreams = entryNames(value.event_streams);
	const missingEventStreams = gatewayContractCatalog.eventStreams.filter(
		(name) => !eventStreams.has(name),
	);
	if (missingEventStreams.length > 0) {
		throw new Error(`missing_event_streams: count=${missingEventStreams.length}`);
	}
}

export function sidecarStartupTimeoutMs(env: NodeJS.ProcessEnv): number {
	const parsed = Number(env.MYCLI_SIDECAR_START_TIMEOUT_MS);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_STARTUP_TIMEOUT_MS;
	}
	return Math.min(MAX_STARTUP_TIMEOUT_MS, Math.max(MIN_STARTUP_TIMEOUT_MS, parsed));
}

function entryNames(value: unknown): Set<string> {
	if (!Array.isArray(value)) {
		return new Set();
	}
	return new Set(
		value.flatMap((entry) =>
			isRecord(entry) && typeof entry.name === "string" ? [entry.name] : [],
		),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
