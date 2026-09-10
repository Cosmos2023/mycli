import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { createErrorContext, errorSummary, readErrorContext } from "@mycli/contracts";
import { runCli } from "../../src/cli.ts";
import { parseHeadlessCommand } from "../../src/headless/arguments.ts";
import { compileOutputSchema } from "../../src/headless/output-schema.ts";
import { runHeadlessCommand } from "../../src/headless/run.ts";
import { completeHeadlessTurn, fakeHeadlessBackend } from "../support/headless-backend.ts";

test("headless JSON and text preserve the same error facts as the TUI contract", async () => {
	const context = createErrorContext({ reason: "capability.image_input_unsupported", source: "provider",
		scope: { kind: "turn", id: "test-turn" }, details: { model: "text-only", input_origin: "history" },
		outcome: { state: "failed", effects: "none" },
	});
	for (const json of [false, true]) {
		const fake = fakeHeadlessBackend({ onSubmit: (request, emit) => emit("turn.failed", {
			client_turn_id: request.params.client_turn_id, turn_id: "test-turn", code: "unsupported_capability",
			message: "old broad message", error_context: context, recovery_actions: ["select_compatible_model"],
		}) });
		const stdout: string[] = [];
		const stderr: string[] = [];
		const code = await runCli({ argv: ["exec", "task", ...(json ? ["--json"] : [])],
			stdout: { write: (text) => stdout.push(text) }, stderr: { write: (text) => stderr.push(text) }, startNodeBackend: () => fake.backend,
		});
		assert.equal(code, 1);
		if (json) {
			const result = JSON.parse(stdout.join("").trim().split("\n").at(-1)!);
			assert.deepEqual(readErrorContext(result.error_context), context);
			assert.equal(result.message, errorSummary(context));
			assert.deepEqual(result.recovery_actions, ["select_compatible_model"]);
		} else assert.ok(stderr.join("").includes(errorSummary(context)));
	}
});

test("headless parser validates command boundaries, duplicate options, and durations", () => {
	assert.deepEqual(parseHeadlessCommand("exec", ["--json", "--timeout=12", "-p", "dev", "--", "--help"]), {
		kind: "exec", json: true, timeoutMs: 12000, runtimeArgs: ["--profile", "dev"], prompt: "--help",
	});
	const review = parseHeadlessCommand("review", []);
	assert.ok(review.kind === "review");
	assert.deepEqual(review.target, { kind: "uncommitted" });
	for (const args of [["--timeout", "0"], ["--timeout", "Infinity"], ["--json", "--json"], ["-o", "a", "--output-last-message", "b"], ["--base", "main"], ["-", "extra"]]) {
		assert.throws(() => parseHeadlessCommand("exec", args));
	}
	assert.throws(() => parseHeadlessCommand("review", ["--base", "main", "--commit", "HEAD"]), /review_target_conflict/u);
	assert.throws(() => parseHeadlessCommand("review", ["--session", "old"]));
});

test("exec consumes stdin without a TTY or TUI and emits clean versioned JSONL", async () => {
	const fake = fakeHeadlessBackend();
	const stdout: string[] = [];
	const hooks = new EventEmitter();
	const code = await runCli({
		argv: ["exec", "--json", "-"], cwd: "/repo", env: {}, stdin: Readable.from(["fix ", "the bug"]),
		stdout: { write: (value) => stdout.push(value) }, stderr: { write: () => assert.fail("unexpected stderr") },
		processHooks: hooks, startNodeBackend: () => fake.backend,
		importTui: async () => assert.fail("TUI must not load"),
	});
	assert.equal(code, 0);
	assert.equal(fake.requests.find((request) => request.method === "turn.submit")?.params.message, "fix the bug");
	const events = stdout.join("").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	assert.ok(events.every((event) => event.version === 1));
	assert.deepEqual(events.map((event) => event.type), ["session.started", "turn.started", "message.delta", "exec.result"]);
	assert.equal(events.at(-1)?.final_message, "done");
	assert.equal(fake.closed(), true);
	assert.equal(hooks.listenerCount("SIGINT"), 0);
});

test("exec help is local and option terminators preserve literal prompt text", async () => {
	const stdout: string[] = [];
	await runCli({ argv: ["exec", "--help"], stdout: { write: (text) => stdout.push(text) }, startNodeBackend: () => assert.fail("unexpected startup") });
	assert.match(stdout.join(""), /--output-schema/u);
	const fake = fakeHeadlessBackend();
	await runCli({ argv: ["exec", "--", "--help"], stdout: { write: () => undefined }, startNodeBackend: () => fake.backend });
	assert.equal(fake.requests.find((request) => request.method === "turn.submit")?.params.message, "--help");
});

test("exec requires input and rejects invalid schemas before starting a backend", async () => {
	const errors: string[] = [];
	const code = await runCli({ argv: ["exec"], stdin: { isTTY: true }, stderr: { write: (text) => errors.push(text) }, startNodeBackend: () => assert.fail("unexpected startup") });
	assert.equal(code, 2);
	assert.match(errors.join(""), /prompt_required/u);
	for (const schema of [{ $ref: "https://example.invalid/schema" }, { $async: true, type: "object" }, { type: "string", format: "unknown-format" }]) {
		assert.throws(() => compileOutputSchema(schema), /output_schema_invalid/u);
	}
});

test("exec handles a broken stdout pipe and still releases the backend", async () => {
	const fake = fakeHeadlessBackend();
	const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("EPIPE")); } });
	const code = await runCli({ argv: ["exec", "task"], stdout: output, stderr: { write: () => undefined }, startNodeBackend: () => fake.backend });
	assert.equal(code, 1);
	assert.equal(fake.closed(), true);
	assert.equal(output.listenerCount("error"), 0);
});

test("schema mismatch fails without replacing the final-output file", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-headless-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "schema.json"), JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }));
	await writeFile(join(root, "answer.json"), "preserve");
	for (const [text, expected] of [["{}", 1], ['{"ok":true}', 0]] as const) {
		const fake = fakeHeadlessBackend({ onSubmit: (request, emit) => completeHeadlessTurn(request, emit, text) });
		const code = await runCli({
			argv: ["exec", "task", "--output-schema", "schema.json", "-o", "answer.json"], cwd: root,
			stdout: { write: () => undefined }, stderr: { write: () => undefined }, startNodeBackend: () => fake.backend,
		});
		assert.equal(code, expected);
		assert.equal(await readFile(join(root, "answer.json"), "utf8"), expected === 0 ? `${text}\n` : "preserve");
		assert.equal(fake.closed(), true);
	}
});

test("exec returns interaction status without submitting or answering pending decisions", async (t) => {
	for (const options of [{ trust: "unknown" }, { pending: true }, {
		onSubmit: (_request: unknown, emit: (method: string, params: Readonly<Record<string, unknown>>) => void) => emit("approval.request", { decision_id: "approval", options: [], preview: "private command" }),
	}, {
		onSubmit: (_request: unknown, emit: (method: string, params: Readonly<Record<string, unknown>>) => void) => emit("clarify.request", { call_id: "call", request_id: "clarify", tool_id: "question", tool_name: "AskUserQuestion", question: "private question", multi_select: false, options: [] }),
	}]) {
		await t.test(JSON.stringify(Object.keys(options)), async () => {
			const fake = fakeHeadlessBackend(options);
			const output: string[] = [];
			const code = await runCli({ argv: ["exec", "task", "--json"], stdout: { write: (text) => output.push(text) }, stderr: { write: () => undefined }, startNodeBackend: () => fake.backend });
			assert.equal(code, 3);
			assert.ok(fake.requests.every((request) => !request.method.endsWith("respond") && request.method !== "workspace.trust.set"));
			assert.doesNotMatch(output.join(""), /private command|private question/u);
			assert.equal(fake.closed(), true);
		});
	}
});

test("failure, timeout, and interrupt return nonzero statuses and close the backend", async (t) => {
	for (const scenario of ["failure", "timeout", "SIGINT", "SIGTERM"] as const) {
		await t.test(scenario, async () => {
			const hooks = new EventEmitter();
			const fake = fakeHeadlessBackend({ onSubmit: (request, emit) => {
				if (scenario === "failure") emit("turn.failed", { client_turn_id: request.params.client_turn_id, turn_id: "test-turn", code: "provider_error", message: "failed" });
				else if (scenario !== "timeout") hooks.emit(scenario);
			} });
			const command = parseHeadlessCommand("exec", ["task"]);
			const code = await runHeadlessCommand({ command: { ...command, timeoutMs: 30 }, cwd: "/repo", env: {}, stdin: Readable.from([]), stdout: { write: () => undefined }, stderr: { write: () => undefined }, processHooks: hooks, startBackend: () => fake.backend });
			assert.equal(code, { failure: 1, timeout: 124, SIGINT: 130, SIGTERM: 143 }[scenario]);
			assert.equal(fake.closed(), true);
			assert.equal(hooks.listenerCount("SIGINT"), 0);
		});
	}
});
