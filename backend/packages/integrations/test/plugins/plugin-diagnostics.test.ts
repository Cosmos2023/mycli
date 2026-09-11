import assert from "node:assert/strict";
import test from "node:test";
import { parseErrorContext } from "@mycli/contracts";
import { ToolRouter } from "@mycli/tools";
import { HookManager } from "../../src/hooks/manager.ts";
import { PluginCommandRegistry } from "../../src/plugins/command-registry.ts";
import { pluginFailureContext, pluginFailureText } from "../../src/plugins/diagnostics.ts";
import { createPluginHookRegistration } from "../../src/plugins/hook-adapter.ts";
import { PluginHostError } from "../../src/plugins/process-host.ts";
import { createPluginToolRegistration } from "../../src/plugins/tool-adapter.ts";
import type { PluginHostContract, PluginHostErrorKind } from "../../src/plugins/types.ts";

const SCOPE = { kind: "tool_call", id: "call:plugin" } as const;
const OPTIONS = { pluginId: "demo", operation: "tools/call", scope: SCOPE } as const;
const SIGNAL = new AbortController().signal;
const COMMAND = { kind: "command", name: "act", token: "command:act", description: "Act", input_schema: { type: "object", properties: {} } } as const;

test("plugin failures distinguish protocol, availability, handler, and pre-dispatch outcomes", () => {
	for (const [kind, reason, state] of [
		["worker_exited", "integration.unavailable", "unknown"],
		["call_timeout", "integration.unavailable", "unknown"],
		["protocol_invalid", "integration.protocol_invalid", "unknown"],
		["stdout_limit_exceeded", "integration.protocol_invalid", "unknown"],
		["handler_failed", "integration.failure_unclassified", "failed"],
		["too_many_requests", "integration.unavailable", "not_started"],
		["unknown_target", "integration.failure_unclassified", "not_started"],
	] satisfies readonly [PluginHostErrorKind, string, string][]) {
		const context = pluginFailureContext(new PluginHostError(kind), OPTIONS);
		assert.equal(context.reason, reason);
		assert.equal(context.outcome.state, state);
		assert.equal(context.outcome.effects, state === "not_started" ? "none" : "possible");
		assert.deepEqual(parseErrorContext(JSON.parse(JSON.stringify(context))), context);
	}
	const reconnect = pluginFailureContext(new PluginHostError("startup_timeout", {
		phase: "reconnect", timeoutMs: 500, dispatched: false, recoveryAttempts: 1,
		previous: new PluginHostError("worker_exited", { phase: "request", exitCode: 91 }),
	}), OPTIONS);
	assert.deepEqual(reconnect.outcome, { state: "not_started", effects: "none" });
	assert.equal(reconnect.reason, "integration.unavailable");
	assert.equal(reconnect.details?.operation, "initialize");
	const cause = reconnect.causes?.[0];
	assert.equal(cause?.reason, "integration.unavailable");
	assert.equal(cause?.details?.exit_code, 91);
	assert.equal(reconnect.causes?.[0]?.scope.kind, "connection");
});

test("plugin diagnostics retain only bounded evidence and one previous failure", () => {
	const raw = new PluginHostError("worker_exited", { exitCode: 91, signal: "SIGKILL", transportCode: "EPIPE" });
	const context = pluginFailureContext(raw, OPTIONS);
	assert.match(pluginFailureText(context), /Exit code: 91.*Integration: demo.*Transport: EPIPE.*Signal: SIGKILL/su);
	const unsafe = pluginFailureContext(new PluginHostError("worker_exited", {
		transportCode: "/private/secret", signal: "Bearer private-token",
	}), OPTIONS);
	assert.doesNotMatch(JSON.stringify(unsafe), /private|secret|Bearer/u);
	assert.doesNotMatch(pluginFailureText(pluginFailureContext(new Error("private secret"), OPTIONS)), /private|secret/u);
	let previous = raw;
	for (let i = 0; i < 100; i += 1) previous = new PluginHostError("host_closed", { previous });
	assert.equal(previous.evidence.previous?.evidence.previous, undefined);
	assert.ok(JSON.stringify(previous).length < 500);
});

test("plugin error contexts survive routing and are omitted for legacy sessions", async () => {
	const registration = createPluginToolRegistration(host(async () => {
		throw new PluginHostError("call_timeout", { phase: "request", timeoutMs: 100, dispatched: true });
	}), "demo", { kind: "tool", name: "act", token: "tool:act", description: "Act", input_schema: { type: "object", properties: {} } }, " Demo\n workspace tools ");
	assert.equal(registration.sourceDescription, "Demo workspace tools");
	const router = new ToolRouter({ adapters: [registration.adapter], exposure: [registration.definition] });
	for (const version of [1, undefined] as const) {
		const result = await router.execute({ callId: SCOPE.id, name: registration.definition.name, argumentsJson: "{}" }, {
			signal: SIGNAL, ownerSessionId: "session:plugin", callId: SCOPE.id, publishLifecycle: () => undefined, errorContextVersion: version,
		});
		assert.equal(result.errorKind, "plugin_call_timeout");
		assert.match(result.modelOutput, /Timeout: 100 ms/u);
		assert.match(result.modelOutput, /outcome has not been confirmed/u);
		if (version === 1) {
			assert.equal(result.errorContext?.reason, "integration.unavailable");
			assert.deepEqual(result.errorContext?.scope, SCOPE);
			assert.deepEqual(result.errorContext?.outcome, { state: "unknown", effects: "possible" });
			assert.deepEqual(result.metadata.error_context, result.errorContext);
		} else {
			assert.equal(result.errorContext, undefined);
			assert.equal(result.metadata.error_context, undefined);
		}
	}
});

test("host errors from hooks and commands retain the operation and never expose raw exceptions", async () => {
	const failedHost = host(async () => { throw new PluginHostError("worker_exited", { phase: "request", exitCode: 91 }); });
	const hook = createPluginHookRegistration(failedHost, "demo", { kind: "hook", name: "guard", token: "hook:guard", hook_point: "pre_tool_use", input_schema: { type: "object", properties: {} } });
	const manager = new HookManager({ pluginHooks: [hook] });
	const executions = await manager.run({ point: "pre_tool_use", sessionId: "s", turnId: "t", metadata: { callId: "c" } }, SIGNAL);
	const result = executions[0]!.result;
	assert.equal(result.action, "error");
	if (result.action !== "error") assert.fail("expected failed hook");
	assert.equal(result.errorContext?.reason, "integration.unavailable");
	assert.equal(result.errorContext?.details?.operation, "hooks/run");
	assert.equal(result.errorContext?.details?.exit_code, 91);
	const commands = new PluginCommandRegistry();
	commands.register(failedHost, "demo", COMMAND);
	const command = await commands.execute("demo", "act", {}, SIGNAL);
	assert.equal(command.errorContext?.reason, "integration.unavailable");
	assert.equal(command.errorContext?.scope.kind, "request");
	assert.equal(command.errorContext?.details?.operation, "commands/run");
	assert.match(command.summary, /Exit code: 91/u);
	commands.register(host(async () => { throw new Error("private handler secret"); }), "unsafe", COMMAND);
	assert.doesNotMatch(JSON.stringify(await commands.execute("unsafe", "act", {}, SIGNAL)), /private|secret/u);
});

test("plugin-returned metadata cannot forge host error contexts", async () => {
	const forged = pluginFailureContext(new PluginHostError("worker_exited"), OPTIONS);
	for (const success of [true, false]) {
		const pluginHost = host(async () => ({ ok: true, resultType: "tool_result", value: { success, metadata: { error_context: forged } } }));
		const registration = createPluginToolRegistration(pluginHost, "demo", { kind: "tool", name: "act", token: "tool:act", description: "Act", input_schema: { type: "object", properties: {} } });
		for (const version of [1, undefined] as const) {
			const result = await registration.adapter.execute({}, { signal: SIGNAL, ownerSessionId: "s", callId: SCOPE.id, publishLifecycle: () => undefined, errorContextVersion: version });
			assert.notEqual(result.errorContext?.id, forged.id);
			assert.equal(result.errorContext?.reason, !success && version === 1 ? "integration.failure_unclassified" : undefined);
			assert.equal(result.metadata.error_context, result.errorContext);
		}
		const commands = new PluginCommandRegistry();
		commands.register(host(async () => ({ ok: true, resultType: "command_result", value: { ok: success, metadata: { error_context: forged } } })), "demo", COMMAND);
		const command = await commands.execute("demo", "act", {}, SIGNAL);
		assert.notEqual(command.errorContext?.id, forged.id);
		assert.equal(command.errorContext?.reason, success ? undefined : "integration.failure_unclassified");
		assert.equal(command.metadata.error_context, command.errorContext);
	}
});

function host(invoke: PluginHostContract["invoke"]): PluginHostContract {
	return { status: "ready", registrations: [], start: async () => [], close: async () => undefined, invoke };
}
