import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../../../", import.meta.url);
const RUNNER = new URL("scripts/smoke_node_agents.mjs", ROOT);

test("agent smoke skips with one sanitized summary when credentials are missing", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-agent-smoke-test-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = await runSmoke(workspace, {
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
		python_started: false,
		credential: "missing",
	});
});

function runSmoke(
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(RUNNER), "--protocol", "responses"], {
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
