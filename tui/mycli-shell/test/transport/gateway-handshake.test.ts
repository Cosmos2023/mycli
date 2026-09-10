import assert from "node:assert/strict";
import test from "node:test";
import { gatewayContractCatalog } from "@mycli/contracts";
import {
	sidecarStartupTimeoutMs,
	verifyGatewayManifest,
} from "../../src/transport/gateway-handshake.ts";

function compatibleManifest(): Record<string, unknown> {
	return {
		schema_version: 1,
		rpc_methods: gatewayContractCatalog.rpcMethods.map((name) => ({ name })),
		event_streams: gatewayContractCatalog.eventStreams.map((name) => ({ name })),
	};
}

test("handshake accepts the canonical gateway surface and additive names", () => {
	const manifest = compatibleManifest();
	(manifest.rpc_methods as object[]).push({ name: "future.method" });

	assert.doesNotThrow(() => verifyGatewayManifest(manifest));
});

test("handshake rejects incompatible manifests without dumping payloads", () => {
	const manifest = compatibleManifest();
	manifest.schema_version = 999;
	manifest.secret = "do-not-print";

	assert.throws(
		() => verifyGatewayManifest(manifest),
		(error: unknown) =>
			error instanceof Error &&
			/incompatible_protocol/.test(error.message) &&
			!/do-not-print/.test(error.message),
	);
});

test("handshake rejects a missing canonical event", () => {
	const manifest = compatibleManifest();
	manifest.event_streams = [{ name: "runtime.ready" }];

	assert.throws(() => verifyGatewayManifest(manifest), /missing_event_streams/);
});

test("handshake rejects a missing canonical RPC method", () => {
	const manifest = compatibleManifest();
	manifest.rpc_methods = [{ name: "extension.manifest" }];

	assert.throws(() => verifyGatewayManifest(manifest), /missing_rpc_methods/);
});

test("sidecar startup timeout defaults and remains bounded", () => {
	assert.equal(sidecarStartupTimeoutMs({}), 10_000);
	assert.equal(sidecarStartupTimeoutMs({ MYCLI_SIDECAR_START_TIMEOUT_MS: "100" }), 1_000);
	assert.equal(sidecarStartupTimeoutMs({ MYCLI_SIDECAR_START_TIMEOUT_MS: "90000" }), 60_000);
	assert.equal(sidecarStartupTimeoutMs({ MYCLI_SIDECAR_START_TIMEOUT_MS: "invalid" }), 10_000);
});
