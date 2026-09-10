import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CORPUS_ROOT, containedPath, loadCorpus } from "../coding-evaluation/corpus.mjs";
import { runBoundedProcess } from "../coding-evaluation/process.mjs";
import { eventMetrics, runEvaluation } from "../run-coding-evaluation.mjs";

test("evaluation verifies fixture hashes before exposing any task", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-eval-corpus-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await cp(CORPUS_ROOT, root, { recursive: true });
	assert.equal((await loadCorpus(root)).tasks.length, 3);
	await writeFile(join(root, "tasks", "inclusive-range.json"), "{}");
	await assert.rejects(loadCorpus(root), /evaluation_fixture_hash_mismatch/u);
	assert.throws(() => containedPath(root, "../escape"), /evaluation_path_invalid/u);
});

test("evaluation scores isolated fixes and rejects the unchanged baseline and false success", { timeout: 30_000 }, async () => {
	const { tasks } = await loadCorpus();
	const fake = fileURLToPath(new URL("./fixtures/coding-evaluation-agent.mjs", import.meta.url));
	const report = await runEvaluation({ tasks, agentArgv: [process.execPath, fake], timeoutMs: 5000 });
	assert.equal(report.passed, 3);
	assert.ok(report.tasks.every((task) => task.checks_passed === task.checks_total));
	assert.ok(report.tasks.every((task) => task.tool_calls === 1 && task.usage.input_tokens === 10));
	const baseline = await runEvaluation({ tasks, agentArgv: [process.execPath, "-e", "process.stdin.resume()"], timeoutMs: 5000 });
	assert.equal(baseline.passed, 0);
	assert.ok(baseline.tasks.every((task) => task.checks_passed < task.checks_total));
});

test("evaluation does not accept a grader process that exits before reporting checks", { timeout: 10_000 }, async () => {
	const { tasks } = await loadCorpus();
	const task = tasks[0];
	const report = await runEvaluation({ tasks: [task], agentArgv: [process.execPath, "-e", "require('node:fs').writeFileSync('range.mjs', 'process.exit(0);')"], timeoutMs: 2000 });
	assert.equal(report.passed, 0);
	assert.equal(report.tasks[0].checks_passed, 0);
});

test("evaluation bounds timed-out processes, output, and failed launches", { timeout: 10_000 }, async () => {
	const base = { cwd: process.cwd(), env: process.env, timeoutMs: 150 };
	const timeout = await runBoundedProcess({ ...base, argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"] });
	assert.equal(timeout.reason, "timeout");
	const output = await runBoundedProcess({ ...base, timeoutMs: 5000, argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(5 * 1024 * 1024))"] });
	assert.equal(output.reason, "output_limit");
	const failed = await runBoundedProcess({ ...base, argv: ["mycli-eval-missing-executable"] });
	assert.equal(failed.reason, "spawn_failed");
});

test("evaluation --list is provider-free and usage extraction excludes arbitrary output", async () => {
	const runner = fileURLToPath(new URL("../run-coding-evaluation.mjs", import.meta.url));
	const result = await runBoundedProcess({ argv: [process.execPath, runner, "--list", "--json"], cwd: process.cwd(), env: {}, timeoutMs: 5000 });
	assert.equal(result.code, 0);
	assert.equal(JSON.parse(result.stdout).tasks.length, 3);
	assert.deepEqual(eventMetrics('private arbitrary text\n{"type":"exec.result","usage":{"input_tokens":3,"secret":"hidden","bad-key":4}}\n'), {
		tool_calls: 0, interactions: 0, usage: { input_tokens: 3 },
	});
	const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
	assert.equal(manifest.scripts["eval:coding"], "node scripts/run-coding-evaluation.mjs");
});
