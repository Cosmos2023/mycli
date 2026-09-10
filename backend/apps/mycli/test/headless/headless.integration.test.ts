import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { WorkspaceTrustStore } from "@mycli/config";
import { runCli } from "../../src/cli.ts";
import { startTestNodeBackend } from "../support/offline-update-fetch.ts";
import { writeResponsesText, writeResponsesTool } from "../support/responses-sse.ts";

const executeFile = promisify(execFile);

test("exec runs through the real gateway and supervisor with layered instructions and usage", { timeout: 30_000 }, async (t) => {
	const fixture = await backendFixture(t, (_payload, response) => writeResponsesText(response, '{"ok":true}', "response", { input_tokens: 2, output_tokens: 3 }));
	const child = join(fixture.workspace, "service");
	await mkdir(child);
	await executeFile("git", ["init", "-q", fixture.workspace]);
	await writeFile(join(fixture.workspace, "AGENTS.md"), "root policy: keep the public API");
	await writeFile(join(child, "AGENTS.md"), "service policy: validate the input");
	await new WorkspaceTrustStore({ homeDir: fixture.home }).save(child, "trusted");
	for (const supervised of [false, true]) {
		const output: string[] = [];
		const errors: string[] = [];
		const code = await runCli({
			argv: ["exec", "inspect the code", "--json", "--session", `headless-${supervised}`, "--model", "gpt-test"],
			cwd: child, env: fixture.env, stdout: { write: (text) => output.push(text) }, stderr: { write: (text) => errors.push(text) },
			...(!supervised ? { startNodeBackend: startTestNodeBackend } : {}),
		});
		assert.equal(code, 0, errors.join(""));
		const result = JSON.parse(output.at(-1)!) as Record<string, unknown>;
		assert.equal(result.status, "completed");
		assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
		const input = JSON.stringify(fixture.requests.at(-1)?.input);
		assert.match(input, /root policy: keep the public API/u);
		assert.match(input, /service policy: validate the input/u);
	}
});

for (const supervised of [false, true]) {
test(`exec interrupts its old approval before a new request after restart (supervised=${supervised})`, { timeout: 20_000 }, async (t) => {
	let requestCount = 0;
	const fixture = await backendFixture(t, (_payload, response) => {
		if (++requestCount === 1) writeResponsesTool(response, "approval-call", "Shell", {
			command: "node -e 'process.exit(0)'", sandbox_permissions: "require_escalated", justification: "Run an approved command", yield_time_ms: 1000,
		}, "approval-response");
		else writeResponsesText(response, "New request completed.", "new-response");
	});
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const output: string[] = [];
		const errors: string[] = [];
		const code = await runCli({
			argv: ["exec", "run the task", "--json", "--session", "approval-session", "--model", "gpt-test"],
			cwd: fixture.workspace, env: fixture.env,
			stdout: { write: (text) => output.push(text) }, stderr: { write: (text) => errors.push(text) },
			...(!supervised ? { startNodeBackend: startTestNodeBackend } : {}),
		});
		assert.equal(code, attempt === 0 ? 3 : 0, errors.join(""));
		if (attempt === 0) assert.match(output.join(""), /approval_required/u);
		else assert.match(output.join(""), /New request completed/u);
		assert.equal(fixture.requests.length, attempt + 1);
	}
});
}

test("review denies a provider-requested write and returns validated findings through the supervisor", { timeout: 30_000 }, async (t) => {
	let step = 0;
	const fixture = await backendFixture(t, (_payload, response) => {
		step += 1;
		if (step === 1) writeResponsesTool(response, "forbidden-write", "Write", { file_path: "example.mjs", content: "changed by reviewer" }, "write-response");
		else writeResponsesText(response, JSON.stringify({ summary: "One defect found. Tests were not run.", findings: [{ severity: "P2", title: "Incorrect return value", body: "Calling answer returns 41 rather than the required 42. Return 42.", location: { path: "example.mjs", start_line: 1, end_line: 1 } }] }), "review-response");
	});
	await executeFile("git", ["init", "-q", fixture.workspace]);
	await writeFile(join(fixture.workspace, "example.mjs"), "export function answer() { return 41; }\n");
	const output: string[] = [];
	const errors: string[] = [];
	const code = await runCli({ argv: ["review", "--json", "--model", "gpt-test"], cwd: fixture.workspace, env: fixture.env, stdout: { write: (text) => output.push(text) }, stderr: { write: (text) => errors.push(text) } });
	assert.equal(code, 0, errors.join(""));
	assert.equal(await readFile(join(fixture.workspace, "example.mjs"), "utf8"), "export function answer() { return 41; }\n");
	assert.deepEqual((fixture.requests[0]?.tools as { name?: string }[]).flatMap((tool) => tool.name ? [tool.name] : []), ["Read"]);
	assert.match(JSON.stringify(fixture.requests[1]?.input), /unsupported call: Write/u);
	const result = JSON.parse(output.at(-1)!) as { structured_output: { findings: unknown[] } };
	assert.equal(result.structured_output.findings.length, 1);
});

async function backendFixture(t: test.TestContext, respond: (payload: Record<string, unknown>, response: ServerResponse) => void): Promise<{
	readonly home: string; readonly workspace: string; readonly env: NodeJS.ProcessEnv; readonly requests: Record<string, unknown>[];
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-headless-integration-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(join(home, ".mycli"), { recursive: true });
	await mkdir(workspace);
	await writeFile(join(home, ".mycli", "config.toml"), "[updates]\ncheck_on_startup = false\n");
	await new WorkspaceTrustStore({ homeDir: home }).save(workspace, "trusted");
	const requests: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body) as Record<string, unknown>;
			requests.push(payload);
			response.writeHead(200, { "content-type": "text/event-stream" });
			respond(payload, response);
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return { home, workspace, requests, env: {
		HOME: home, USERPROFILE: home, PATH: process.env.PATH,
		MYCLI_API_KEY: "test-key", MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
		MYCLI_PROVIDER: "openai", MYCLI_PROTOCOL: "responses", MYCLI_THINKING_ENABLED: "false", MYCLI_STREAM_MAX_RETRIES: "0",
	} };
}
