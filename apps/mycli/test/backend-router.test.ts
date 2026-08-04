import assert from "node:assert/strict";
import test from "node:test";
import { selectRuntimeBackend } from "../src/backend-router.ts";

test("M1 defaults to the Python sidecar", () => {
	assert.equal(selectRuntimeBackend({ argv: [], env: {} }), "python-sidecar");
});

test("backend selection accepts explicit CLI and environment values", () => {
	assert.equal(selectRuntimeBackend({
		argv: ["--runtime-backend", "python-sidecar"],
		env: {},
	}), "python-sidecar");
	assert.equal(selectRuntimeBackend({
		argv: [],
		env: { MYCLI_RUNTIME_BACKEND: "python-sidecar" },
	}), "python-sidecar");
});

test("command-line backend selection wins over the environment", () => {
	assert.equal(selectRuntimeBackend({
		argv: ["--runtime-backend=python-sidecar"],
		env: { MYCLI_RUNTIME_BACKEND: "node" },
	}), "python-sidecar");
});

test("native Node selection is available without fallback", () => {
	assert.equal(
		selectRuntimeBackend({ argv: ["--runtime-backend", "node"], env: {} }),
		"node",
	);
	assert.equal(
		selectRuntimeBackend({ argv: [], env: { MYCLI_RUNTIME_BACKEND: "node" } }),
		"node",
	);
});

test("backend selection rejects unknown, missing, and conflicting CLI values", () => {
	assert.throws(
		() => selectRuntimeBackend({ argv: ["--runtime-backend", "ruby"], env: {} }),
		/runtime_backend_invalid/,
	);
	assert.throws(
		() => selectRuntimeBackend({ argv: ["--runtime-backend"], env: {} }),
		/runtime_backend_invalid/,
	);
	assert.throws(
		() => selectRuntimeBackend({
			argv: ["--runtime-backend", "python-sidecar", "--runtime-backend=node"],
			env: {},
		}),
		/runtime_backend_conflict/,
	);
});
