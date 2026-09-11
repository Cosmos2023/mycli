import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { containedPath, loadCorpus } from "./coding-evaluation/corpus.mjs";
import { runBoundedProcess } from "./coding-evaluation/process.mjs";

const CLI_PATH = fileURLToPath(new URL("../backend/apps/mycli/dist/cli.js", import.meta.url));
const SCORE_PATH = fileURLToPath(new URL("./coding-evaluation/score.mjs", import.meta.url));

export async function runEvaluation({ tasks, agentArgv, model, env = process.env, timeoutMs = 120_000, signal }) {
	const results = [];
	for (const task of tasks) {
		if (signal?.aborted) break;
		const temporary = await mkdtemp(join(tmpdir(), "mycli-coding-eval-"));
		try {
			const workspace = join(temporary, "workspace");
			const home = join(temporary, "home");
			await mkdir(join(home, ".mycli"), { recursive: true });
			await mkdir(workspace);
			await writeFile(join(home, ".mycli", "config.toml"), "[updates]\ncheck_on_startup = false\n", { mode: 0o600 });
			for (const [path, content] of Object.entries(task.files)) {
				const destination = containedPath(workspace, path);
				await mkdir(dirname(destination), { recursive: true });
				await writeFile(destination, content, "utf8");
			}
			const cwd = containedPath(workspace, task.cwd);
			const isolatedEnv = { ...env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), MYCLI_AGENT_EXECUTION_ADAPTER: "worker" };
			for (const key of Object.keys(isolatedEnv)) if (key.startsWith("GIT_")) delete isolatedEnv[key];
			isolatedEnv.XDG_CONFIG_HOME = join(home, ".config");
			isolatedEnv.XDG_CACHE_HOME = join(home, ".cache");
			isolatedEnv.XDG_DATA_HOME = join(home, ".local", "share");
			delete isolatedEnv.NODE_OPTIONS;
			delete isolatedEnv.NODE_PATH;
			const initialized = await runBoundedProcess({ argv: ["git", "init", "-q"], cwd: workspace, env: isolatedEnv, timeoutMs: 10_000, signal });
			if (initialized.code !== 0) throw new Error("evaluation_git_init_failed");
			const { WorkspaceTrustStore } = await import("@mycli/config");
			await new WorkspaceTrustStore({ homeDir: home }).save(cwd, "trusted");
			const argv = agentArgv ?? [process.execPath, CLI_PATH, "exec", "--json", "--timeout", String(Math.ceil(timeoutMs / 1000)), ...(model ? ["--model", model] : []), "-"];
			const started = performance.now();
			const execution = await runBoundedProcess({ argv, cwd, env: isolatedEnv, input: `${task.prompt}\n`, timeoutMs, signal });
			const durationMs = Math.round(performance.now() - started);
			const metrics = eventMetrics(execution.stdout);
			const nonce = randomUUID();
			const grading = await runBoundedProcess({
				argv: [process.execPath, SCORE_PATH], cwd: temporary,
				env: { HOME: home, USERPROFILE: home, PATH: env.PATH, ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}) },
				input: JSON.stringify({ task, workspace, nonce }), timeoutMs: 10_000, signal,
			});
			let checks = [];
			if (grading.code === 0) {
				try {
					const grade = JSON.parse(grading.stdout.trim().split("\n").at(-1));
					const expectedIds = [...task.checks.map((check) => check.id), ...task.immutable.map((path) => `immutable:${path}`)];
					if (grade.nonce === nonce && Array.isArray(grade.checks) && grade.checks.length === expectedIds.length
						&& grade.checks.every((check, index) => check.id === expectedIds[index] && typeof check.passed === "boolean")) checks = grade.checks;
				} catch { /* A missing or malformed grader result cannot pass. */ }
			}
			const passed = checks.length > 0 && checks.every((check) => check.passed) && execution.code === 0;
			results.push({ task_id: task.id, passed,
				status: execution.reason ?? (execution.code === 3 ? "interaction_required" : passed ? "passed" : "failed"),
				duration_ms: durationMs, agent_exit_code: execution.code, checks,
				checks_passed: checks.filter((check) => check.passed).length, checks_total: task.checks.length + task.immutable.length,
				...metrics,
			});
		} finally { await rm(temporary, { recursive: true, force: true }); }
	}
	return { version: 1, corpus_version: 1, agent: agentArgv ? "custom" : "mycli", model: model ?? null,
		tasks: results, passed: results.filter((result) => result.passed).length, total: tasks.length, interrupted: signal?.aborted === true };
}

export function eventMetrics(stdout) {
	let usage;
	let toolCalls = 0;
	let interactions = 0;
	for (const line of stdout.split("\n")) {
		try {
			const event = JSON.parse(line);
			if (event.type === "tool.started") toolCalls += 1;
			if (event.type === "interaction.required") interactions += 1;
			if ((event.type === "exec.result" || event.type === "turn.completed") && event.usage && typeof event.usage === "object") {
				usage = Object.fromEntries(Object.entries(event.usage).filter(([key, value]) => /^[a-z_]{1,64}$/u.test(key) && typeof value === "number" && Number.isFinite(value) && value >= 0));
			}
		} catch { /* Other agent output is not part of the metrics protocol. */ }
	}
	return { tool_calls: toolCalls, interactions, ...(usage ? { usage } : {}) };
}

export async function main(args = process.argv.slice(2)) {
	const { values } = parseArgs({ args, strict: true, options: {
		list: { type: "boolean" }, run: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
		task: { type: "string", multiple: true }, model: { type: "string" }, timeout: { type: "string", default: "120" },
		output: { type: "string" }, "agent-command": { type: "string" },
	} });
	if (values.help) {
		process.stdout.write("Usage: npm run eval:coding -- [--list] [--json]\n       npm run eval:coding -- --run [--task id] [--model id] [--timeout seconds] [--output file] [--agent-command file]\n");
		return 0;
	}
	const corpus = await loadCorpus();
	if (values.run && values.list) throw new Error("evaluation_mode_conflict");
	const selected = values.task ?? corpus.tasks.map((task) => task.id);
	if (selected.some((id) => !corpus.tasks.some((task) => task.id === id))) throw new Error("evaluation_task_unknown");
	const tasks = corpus.tasks.filter((task) => selected.includes(task.id));
	if (!values.run) {
		if (values.output || values["agent-command"]) throw new Error("evaluation_run_required");
		process.stdout.write(values.json ? `${JSON.stringify({ version: 1, tasks: tasks.map(({ id, title, checks }) => ({ id, title, checks: checks.length })) }, null, 2)}\n`
			: `${tasks.map((task) => `${task.id}\t${task.title}`).join("\n")}\n`);
		return 0;
	}
	const timeoutMs = Number(values.timeout) * 1000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600_000) throw new Error("evaluation_timeout_invalid");
	let agentArgv;
	if (values["agent-command"]) {
		agentArgv = JSON.parse(await readFile(resolve(values["agent-command"]), "utf8"));
		if (!Array.isArray(agentArgv) || !agentArgv.length || !agentArgv.every((arg) => typeof arg === "string" && arg.length > 0 && !arg.includes("\0"))) throw new Error("evaluation_agent_command_invalid");
	} else if (!process.env.MYCLI_API_KEY) throw new Error("evaluation_requires_MYCLI_API_KEY");
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	try {
		const report = await runEvaluation({ tasks, agentArgv, model: values.model, timeoutMs, signal: controller.signal });
		const serialized = `${JSON.stringify(report, null, 2)}\n`;
		if (values.output) {
			const destination = resolve(values.output);
			const temporary = join(dirname(destination), `.mycli-eval-${randomUUID()}.tmp`);
			try { await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 }); await rename(temporary, destination); }
			finally { await rm(temporary, { force: true }); }
		}
		process.stdout.write(values.json ? serialized : `${report.tasks.map((task) => `${task.task_id}\t${task.status}\t${task.checks_passed}/${task.checks_total}\t${task.duration_ms}ms`).join("\n")}\n${report.passed}/${report.total} tasks passed\n`);
		return report.interrupted ? 130 : report.passed === report.total ? 0 : 1;
	} finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try { process.exitCode = await main(); }
	catch (error) { process.stderr.write(`[mycli eval] ${error instanceof Error && /^evaluation_[a-zA-Z_]+$/u.test(error.message) ? error.message : "evaluation_failed"}\n`); process.exitCode = 2; }
}
