import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayParams, GatewayResult } from "@mycli/contracts";
import { bootstrapGateway, GatewayRequestError } from "../src/index.ts";

const reply: GatewayResult<"session.bootstrap"> = { protocol_version: 1, session_id: "s", workspace: "/fixture", provider: "openai", model: "test", status: {} };

test("bootstrap offers version 1 and accepts legacy peers without an extension", async () => {
	const calls: GatewayParams<"session.bootstrap">[] = [];
	assert.deepEqual(await bootstrapGateway(async (params) => { calls.push(params); return reply; }), reply);
	assert.deepEqual(calls, [{ protocol_version: 1, supported_error_context_versions: [1] }]);
});

test("only an explicit handshake parameter rejection permits a legacy handshake retry", async () => {
	for (const code of ["invalid_params", "pipe_closed", "timeout"]) {
		let calls = 0;
		const result = bootstrapGateway(async (params) => {
			calls += 1;
			if (calls === 1) throw new GatewayRequestError({ method: "session.bootstrap", code,
				message: "Invalid gateway params for session.bootstrap.",
			});
			assert.deepEqual(params, { protocol_version: 1 });
			return reply;
		});
		if (code === "invalid_params") { await result; assert.equal(calls, 2); }
		else { await assert.rejects(result); assert.equal(calls, 1); }
	}
});
