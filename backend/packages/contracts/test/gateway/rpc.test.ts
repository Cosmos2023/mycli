import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	GATEWAY_RPC_METHODS, GatewayRpcValidationError, gatewayContractCatalog,
	isGatewayMethod, parseGatewayParams, parseGatewayResult,
} from "../../src/index.ts";

test("every advertised method and existing compatibility entry has a compilable contract", () => {
	assert.deepEqual([...GATEWAY_RPC_METHODS].sort(), [
		...gatewayContractCatalog.rpcMethods, "initialize", "status.get", "session.resume.preview",
	].sort());
	for (const method of GATEWAY_RPC_METHODS) {
		for (const parse of [parseGatewayParams, parseGatewayResult]) {
			try { parse(method, {}); }
			catch (error) { assert.ok(error instanceof GatewayRpcValidationError, `${method}: ${String(error)}`); }
		}
	}
	assert.equal(isGatewayMethod("toString"), false);
	assert.equal(isGatewayMethod("__proto__"), false);
});

test("mutation contracts reject malformed input without reporting private values", () => {
	for (const [method, params] of [
		["turn.submit", { message: "private prompt", client_turn_id: 3 }],
		["workspace.trust.set", { state: "allow-everything" }],
		["permissions.update", { profile: "admin" }],
		["approval.respond", { decision_id: "id", choice: "yes" }],
		["turn.steer", { message: "private prompt" }],
		["auth.api_key.save", { provider_id: 9, api_key: "private-key" }],
	] as const) {
		assert.throws(() => parseGatewayParams(method, params), (error) => {
			assert.ok(error instanceof GatewayRpcValidationError);
			assert.equal(error.code, "invalid_params");
			assert.doesNotMatch(JSON.stringify(error) + error.message, /private prompt|private-key/);
			return true;
		});
	}
});

test("response contracts preserve transcript records and reject structural drift", () => {
	const page = { session_id: "s", items: [{ id: "m", type: "assistant_final", text: "done", folded: false, metadata: {} }], next_before: null };
	assert.deepEqual(parseGatewayResult("transcript.load", page), page);
	assert.throws(() => parseGatewayResult("transcript.load", { ...page, items: [{ id: "m", text: 4 }] }), GatewayRpcValidationError);
	assert.throws(() => parseGatewayResult("turn.submit", { accepted: "yes" }), GatewayRpcValidationError);
	assert.throws(() => parseGatewayResult("session.bootstrap", { session_id: "s" }), GatewayRpcValidationError);
	assert.deepEqual(parseGatewayParams("turn.follow_up", { message: "next", local_images: [{ path: "/repo/image.png", placeholder: "image" }] }).message, "next");
});

test("RPC schema and generated declarations remain free of any type escapes", () => {
	const declarations = readFileSync(new URL("../../src/generated/gateway-rpc.ts", import.meta.url), "utf8");
	assert.doesNotMatch(declarations, /:\s*any\b/);
});
