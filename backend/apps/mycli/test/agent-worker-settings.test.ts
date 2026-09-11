import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveAgentWorkerSettings } from "../src/node-runtime/agent-worker-settings.ts";
import { startTestNodeBackend as startNodeBackend } from "./support/offline-update-fetch.ts";

test("Agent Worker settings preserve the production defaults", () => {
	assert.deepEqual(resolveAgentWorkerSettings({}), {
		maxWorkers: 4,
		idleTimeoutMs: 30_000,
	});
	assert.deepEqual(resolveAgentWorkerSettings({
		MYCLI_AGENT_WORKER_MAX: "   ",
		MYCLI_AGENT_WORKER_IDLE_TIMEOUT_MS: "",
	}), {
		maxWorkers: 4,
		idleTimeoutMs: 30_000,
	});
});

test("Agent Worker settings accept a bounded low-memory configuration", () => {
	assert.deepEqual(resolveAgentWorkerSettings({
		MYCLI_AGENT_WORKER_MAX: "2",
		MYCLI_AGENT_WORKER_IDLE_TIMEOUT_MS: "5000",
	}), {
		maxWorkers: 2,
		idleTimeoutMs: 5_000,
	});
});

test("Agent Worker settings reject invalid nonblank values without echoing them", () => {
	for (const [name, value] of [
		["MYCLI_AGENT_WORKER_MAX", "1"],
		["MYCLI_AGENT_WORKER_MAX", "5"],
		["MYCLI_AGENT_WORKER_MAX", "2-workers-private"],
		["MYCLI_AGENT_WORKER_IDLE_TIMEOUT_MS", "999"],
		["MYCLI_AGENT_WORKER_IDLE_TIMEOUT_MS", "private-timeout"],
	] as const) {
		assert.throws(
			() => resolveAgentWorkerSettings({ [name]: value }),
			(error: unknown) => error instanceof Error
				&& error.message.startsWith(`${name} must be an integer between `)
				&& !error.message.includes(value),
		);
	}
});

test("invalid Agent Worker settings fail before backend storage or Worker creation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-agent-worker-settings-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const invalidValue = "private-invalid-worker-count";

	await assert.rejects(
		startNodeBackend({
			cwd: root,
			args: [],
			env: {
				HOME: home,
				MYCLI_AGENT_WORKER_MAX: invalidValue,
			},
		}),
		(error: unknown) => error instanceof Error
			&& error.message === "MYCLI_AGENT_WORKER_MAX must be an integer between 2 and 4"
			&& !error.message.includes(invalidValue),
	);
	assert.equal(existsSync(join(home, ".mycli")), false);
});
