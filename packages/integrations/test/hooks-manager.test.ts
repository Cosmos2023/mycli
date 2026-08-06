import assert from "node:assert/strict";
import test from "node:test";
import type { HookInvocation, HookResult } from "@mycli/core";
import {
	HookManager,
	type ConfiguredHookExecutorContract,
	type ConfiguredHookSpec,
	type HookRegistration,
} from "../src/index.ts";

test("runs built-in, configured, and plugin hooks in order with chained arguments", async () => {
	const calls: string[] = [];
	const configured = configuredSpec();
	const manager = new HookManager({
		builtInHooks: [registration("builtin:guard", "pre_tool_use", async (input) => {
			calls.push("builtin");
			assert.deepEqual(input.arguments, { path: "README.md" });
			return { action: "modify", arguments: { builtin: true } };
		})],
		configuredHooks: [configured],
		configuredExecutor: executor(async (_spec, input) => {
			calls.push("configured");
			assert.deepEqual(input.arguments, { path: "README.md", builtin: true });
			return { action: "modify", arguments: { configured: true } };
		}),
		pluginHooks: [registration("plugin:demo:guard", "pre_tool_use", async (input) => {
			calls.push("plugin");
			assert.deepEqual(input.arguments, {
				path: "README.md",
				builtin: true,
				configured: true,
			});
			return { action: "allow" };
		})],
	});

	const results = await manager.run(invocation(), freshSignal());

	assert.deepEqual(calls, ["builtin", "configured", "plugin"]);
	assert.deepEqual(results.map((execution) => execution.hookId), [
		"builtin:guard",
		"configured:repo:check-write",
		"plugin:demo:guard",
	]);
	assert.equal(Object.isFrozen(results), true);
});

test("stops pre-operation hooks on deny or error before later sources execute", async () => {
	const calls: string[] = [];
	const manager = new HookManager({
		builtInHooks: [registration("builtin:deny", "pre_tool_use", async () => {
			calls.push("builtin");
			return { action: "deny", message: "blocked" };
		})],
		configuredHooks: [configuredSpec()],
		configuredExecutor: executor(async () => {
			calls.push("configured");
			return { action: "allow" };
		}),
		pluginHooks: [registration("plugin:late", "pre_tool_use", async () => {
			calls.push("plugin");
			return { action: "allow" };
		})],
	});

	const results = await manager.run(invocation(), freshSignal());

	assert.deepEqual(calls, ["builtin"]);
	assert.deepEqual(results, [{
		hookId: "builtin:deny",
		result: { action: "deny", message: "blocked" },
	}]);
});

test("isolates handler exceptions and continues post-operation hooks", async () => {
	const calls: string[] = [];
	const manager = new HookManager({
		builtInHooks: [registration("builtin:broken", "post_tool_use", async () => {
			throw new Error("token=private-value");
		})],
		pluginHooks: [registration("plugin:context", "post_tool_use", async () => {
			calls.push("plugin");
			return { action: "allow", additionalContexts: ["keep this context"] };
		})],
	});

	const results = await manager.run(invocation("post_tool_use"), freshSignal());

	assert.deepEqual(calls, ["plugin"]);
	assert.deepEqual(results, [
		{ hookId: "builtin:broken", result: { action: "error", message: "hook execution failed" } },
		{
			hookId: "plugin:context",
			result: { action: "allow", additionalContexts: ["keep this context"] },
		},
	]);
	assert.equal(JSON.stringify(results).includes("private-value"), false);
});

test("bounds cumulative contexts and rejects oversized argument modifications", async () => {
	const manager = new HookManager({
		builtInHooks: [
			registration("builtin:contexts", "post_tool_use", async () => ({
				action: "allow",
				additionalContexts: Array.from({ length: 12 }, () => "x".repeat(1_000)),
			})),
			registration("builtin:more", "post_tool_use", async () => ({
				action: "allow",
				additionalContexts: ["y".repeat(2_000)],
			})),
		],
	});

	const contexts = await manager.run(invocation("post_tool_use"), freshSignal());
	const total = contexts.flatMap((execution) => (
		execution.result.action === "allow" ? execution.result.additionalContexts ?? [] : []
	)).join("");
	assert.equal(total.length, 4_000);
	assert.ok(contexts.flatMap((execution) => (
		execution.result.action === "allow" ? execution.result.additionalContexts ?? [] : []
	)).length <= 8);

	const oversized = new HookManager({
		builtInHooks: [registration("builtin:oversized", "pre_tool_use", async () => ({
			action: "modify",
			arguments: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key${index}`, index])),
		}))],
	});
	assert.deepEqual(await oversized.run(invocation(), freshSignal()), [{
		hookId: "builtin:oversized",
		result: { action: "error", message: "hook result exceeded limits" },
	}]);
});

test("preserves multiline contexts, skips blank values, and redacts sensitive values", async () => {
	const manager = new HookManager({
		builtInHooks: [registration("builtin:context-shape", "post_tool_use", async () => ({
			action: "allow",
			additionalContexts: ["", "line one\nline two", "token=private-value"],
		}))],
	});

	assert.deepEqual(await manager.run(invocation("post_tool_use"), freshSignal()), [{
		hookId: "builtin:context-shape",
		result: {
			action: "allow",
			additionalContexts: ["line one\nline two", "redacted"],
		},
	}]);
});

test("maps malformed handler results to bounded errors", async () => {
	const manager = new HookManager({
		builtInHooks: [registration(
			"builtin:malformed",
			"pre_tool_use",
			async () => null as unknown as HookResult,
		)],
	});

	assert.deepEqual(await manager.run(invocation(), freshSignal()), [{
		hookId: "builtin:malformed",
		result: { action: "error", message: "hook result invalid" },
	}]);
});

function registration(
	id: string,
	point: HookRegistration["hookPoint"],
	handler: HookRegistration["handler"],
): HookRegistration {
	return Object.freeze({ id, hookPoint: point, handler });
}

function executor(
	run: ConfiguredHookExecutorContract["run"],
): ConfiguredHookExecutorContract {
	return Object.freeze({ run });
}

function configuredSpec(): ConfiguredHookSpec {
	return Object.freeze({
		hookId: "check-write",
		name: "configured:repo:check-write",
		hookPoint: "pre_tool_use",
		command: [process.execPath, "hook.mjs"],
		enabled: true,
		timeoutMs: 2_000,
		workingDirectory: "workspace",
		envPolicy: "minimal",
		matcher: Object.freeze({ kind: "tool_name" as const, value: "Write" }),
		scope: "repo",
		configPath: "/workspace/.mycli/hooks.json",
	});
}

function invocation(point: HookInvocation["point"] = "pre_tool_use"): HookInvocation {
	return Object.freeze({
		point,
		sessionId: "session-1",
		turnId: "turn-1",
		toolName: "Write",
		arguments: Object.freeze({ path: "README.md" }),
		metadata: Object.freeze({}),
	});
}

function freshSignal(): AbortSignal {
	return new AbortController().signal;
}
