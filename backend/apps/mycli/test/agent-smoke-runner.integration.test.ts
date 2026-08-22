import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../../../", import.meta.url);
const RUNNER = new URL("scripts/smoke_node_agents.mjs", ROOT);
const FOREGROUND_RUNNER = new URL("scripts/smoke_node_agent_foreground.mjs", ROOT);

test("agent smoke skips with one sanitized summary when credentials are missing", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-agent-smoke-test-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = await runSmoke(workspace, [], {
		HOME: home,
		USERPROFILE: home,
		MYCLI_API_KEY: "",
		MYCLI_AUTH_REF: "",
		MYCLI_BASE_URL: "",
		MYCLI_PROVIDER: "openai",
		MYCLI_PROTOCOL: "responses",
		MYCLI_MODEL: "gpt-test",
	});

	assert.equal(result.code, 77);
	assert.equal(result.stderr, "");
	assert.deepEqual(singleSummary(result.stdout), {
		protocol: "responses",
		root_adapter: "default",
		subagent_adapter: "default",
		status: "unavailable",
		tool_counts: {
			spawn_agent: 0,
			send_message: 0,
			followup_task: 0,
			wait_agent: 0,
			interrupt_agent: 0,
			list_agents: 0,
		},
		child_read_count: 0,
		completion_observed: false,
		interruption_observed: false,
		mailbox_persisted: false,
		agent_tree_persisted: false,
		session_reloaded: false,
		backend_reloaded: false,
		parallel_children_observed: false,
		steering_observed: false,
		python_started: false,
		credential: "missing",
		failure_stage: "not_run",
	});
});

test("agent smoke accepts child-first adapter selection without credentials", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-agent-smoke-lanes-test-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = await runSmoke(workspace, [
		"--root-adapter", "in_process",
		"--subagent-adapter", "worker",
	], {
		HOME: home,
		USERPROFILE: home,
		MYCLI_API_KEY: "",
		MYCLI_AUTH_REF: "",
		MYCLI_BASE_URL: "",
		MYCLI_PROVIDER: "openai",
		MYCLI_PROTOCOL: "responses",
		MYCLI_MODEL: "gpt-test",
	});

	assert.equal(result.code, 77);
	assert.equal(result.stderr, "");
	const summary = singleSummary(result.stdout) as Record<string, unknown>;
	assert.equal(summary.status, "unavailable");
	assert.equal(summary.root_adapter, "in_process");
	assert.equal(summary.subagent_adapter, "worker");
	assert.equal(summary.credential, "missing");
	assert.equal(summary.failure_stage, "not_run");
	assert.equal(JSON.stringify(summary).includes(home), false);
});

test("foreground agent smoke skips with one sanitized summary when credentials are missing", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-agent-foreground-smoke-test-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = await runSmokeScript(FOREGROUND_RUNNER, workspace, [], {
		HOME: home,
		USERPROFILE: home,
		MYCLI_API_KEY: "",
		MYCLI_AUTH_REF: "",
		MYCLI_BASE_URL: "",
		MYCLI_PROVIDER: "openai",
		MYCLI_PROTOCOL: "responses",
		MYCLI_MODEL: "gpt-test",
	});

	assert.equal(result.code, 77);
	assert.equal(result.stderr, "");
	assert.deepEqual(singleSummary(result.stdout), {
		protocol: "responses",
		status: "unavailable",
		foreground_completed: false,
		worker_lease_observed: false,
		persisted: false,
		active_lease_count: 0,
		python_started: false,
		credential: "missing",
	});
});

test("agent smoke reports argument failures without echoing invalid values", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-agent-smoke-invalid-test-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	t.after(() => rm(root, { recursive: true, force: true }));
	const secretMarker = "invalid-adapter-secret-marker";

	const result = await runSmoke(workspace, ["--root-adapter", secretMarker], {
		HOME: home,
		USERPROFILE: home,
	});

	assert.equal(result.code, 64);
	assert.equal(result.stderr, "");
	const summary = singleSummary(result.stdout) as Record<string, unknown>;
	assert.equal(summary.status, "failed");
	assert.equal(summary.failure_stage, "arguments");
	assert.equal(JSON.stringify(summary).includes(secretMarker), false);
	assert.equal(JSON.stringify(summary).includes(home), false);
});

test("agent smoke reports a sanitized provider stream timeout stage", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-agent-smoke-timeout-test-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(": waiting\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => (
			error ? reject(error) : resolve()
		)));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const secretMarker = "agent-smoke-timeout-secret-marker";

	const result = await runSmoke(workspace, [
		"--root-adapter", "worker",
		"--subagent-adapter", "in_process",
	], {
		HOME: home,
		USERPROFILE: home,
		MYCLI_API_KEY: secretMarker,
		MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
		MYCLI_PROVIDER: "openai",
		MYCLI_PROTOCOL: "responses",
		MYCLI_MODEL: "gpt-test",
		MYCLI_AGENT_SMOKE_DEADLINE_MS: "3000",
	});

	assert.equal(result.code, 1);
	assert.equal(result.stderr, "");
	const summary = singleSummary(result.stdout) as Record<string, unknown>;
	assert.equal(summary.status, "failed");
	assert.equal(summary.failure_stage, "provider_stream");
	assert.equal(summary.credential, "configured");
	assert.equal(JSON.stringify(summary).includes(secretMarker), false);
	assert.equal(JSON.stringify(summary).includes(home), false);
});

function runSmoke(
	cwd: string,
	adapterArgs: readonly string[],
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return runSmokeScript(RUNNER, cwd, ["--protocol", "responses", ...adapterArgs], env);
}

function runSmokeScript(
	runner: URL,
	cwd: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [
			fileURLToPath(runner),
			...args,
		], {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
}

function singleSummary(stdout: string): unknown {
	const lines = stdout.trim().split(/\r?\n/u);
	assert.equal(lines.length, 1);
	return JSON.parse(lines[0] ?? "") as unknown;
}
