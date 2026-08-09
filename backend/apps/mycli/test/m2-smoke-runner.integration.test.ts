import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../../../", import.meta.url);
const RUNNER = new URL("scripts/smoke_node_m2.mjs", ROOT);

test("M2 smoke dry-run skips with a sanitized summary when credentials are missing", async (t) => {
	const paths = await smokeTree(t);
	await mkdir(join(paths.home, ".mycli"));
	await writeFile(
		join(paths.home, ".mycli", "config.toml"),
		"[reasoning]\neffort = \"high\"\n",
		"utf8",
	);
	const result = await runSmoke(["--protocol", "responses", "--dry-run"], paths.workspace, {
		HOME: paths.home,
		USERPROFILE: paths.home,
		MYCLI_API_KEY: "",
		MYCLI_AUTH_REF: "",
		MYCLI_PROVIDER: "openai",
		MYCLI_MODEL: "gpt-test",
	});

	assert.equal(result.code, 77);
	assert.equal(result.stderr, "");
	assert.deepEqual(singleSummary(result.stdout), {
		protocol: "responses",
		status: "skipped",
		event_counts: {},
		persisted: false,
		credential: "missing",
	});
});

for (const protocol of ["responses", "chat_completions"] as const) {
	test(`M2 smoke completes and persists one bounded ${protocol} turn`, async (t) => {
		const paths = await smokeTree(t);
		const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
		const server = createServer((request, response) => {
			let raw = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => { raw += chunk; });
			request.on("end", () => {
				requests.push({
					path: request.url ?? "",
					body: JSON.parse(raw) as Record<string, unknown>,
				});
				response.writeHead(200, { "content-type": "text/event-stream" });
				if (protocol === "responses") {
					response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n");
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-smoke\",\"usage\":{\"input_tokens\":2,\"output_tokens\":1,\"total_tokens\":3}}}\n\n");
				} else {
					response.write("data: {\"id\":\"chat-smoke\",\"choices\":[{\"delta\":{\"content\":\"OK\"},\"finish_reason\":null}]}\n\n");
					response.write("data: {\"id\":\"chat-smoke\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\n");
				}
				response.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		t.after(() => new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		}));
		const address = server.address();
		assert.ok(address && typeof address === "object");

		const result = await runSmoke(["--protocol", protocol], paths.workspace, {
			HOME: paths.home,
			USERPROFILE: paths.home,
			MYCLI_API_KEY: "test-secret",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_MODEL: "gpt-test",
		});

		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.deepEqual(singleSummary(result.stdout), {
			protocol,
			status: "completed",
			event_counts: { text_delta: 1, completed: 1 },
			persisted: true,
			credential: "configured",
		});
		assert.equal(requests.length, 1);
		assert.equal(requests[0]?.path, protocol === "responses" ? "/v1/responses" : "/v1/chat/completions");
		assert.equal(
			requests[0]?.body[protocol === "responses" ? "max_output_tokens" : "max_completion_tokens"],
			64,
		);
		assert.equal("tools" in (requests[0]?.body ?? {}), false);
		assert.doesNotMatch(result.stdout + result.stderr, /test-secret|127\.0\.0\.1/);
	});
}

test("M2 smoke reports only a stable error code for provider authentication failure", async (t) => {
	const paths = await smokeTree(t);
	const server = createServer((_request, response) => {
		response.writeHead(401, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: "upstream-secret-detail" } }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	}));
	const address = server.address();
	assert.ok(address && typeof address === "object");

	const result = await runSmoke(["--protocol", "responses"], paths.workspace, {
		HOME: paths.home,
		USERPROFILE: paths.home,
		MYCLI_API_KEY: "test-secret",
		MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
		MYCLI_PROVIDER: "openai",
		MYCLI_MODEL: "gpt-test",
	});

	assert.equal(result.code, 1);
	assert.equal(result.stderr, "");
	assert.deepEqual(singleSummary(result.stdout), {
		protocol: "responses",
		status: "failed",
		event_counts: {},
		persisted: false,
		credential: "configured",
		error_code: "auth_error",
	});
	assert.doesNotMatch(result.stdout + result.stderr, /test-secret|upstream-secret-detail/);
});

async function smokeTree(t: TestContext): Promise<{ home: string; workspace: string }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-m2-smoke-test-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	t.after(() => rm(root, { recursive: true, force: true }));
	return { home, workspace };
}

function runSmoke(
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(RUNNER), ...args], {
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
	const lines = stdout.trim().split(/\r?\n/);
	assert.equal(lines.length, 1);
	return JSON.parse(lines[0] ?? "") as unknown;
}
