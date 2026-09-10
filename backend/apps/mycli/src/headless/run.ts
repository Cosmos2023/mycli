import { resolve } from "node:path";
import { Writable } from "node:stream";
import type { NodeBackend } from "../node-runtime/node-backend.ts";
import { startSupervisedNodeBackend } from "../node-runtime/node-backend-supervisor.ts";
import { loadOutputSchema, type OutputSchema } from "./output-schema.ts";
import { MAX_PROMPT_BYTES, readPrompt, writeFinalMessage, type HeadlessInput } from "./io.ts";
import { runHeadlessSession, type HeadlessBackendFactory } from "./session.ts";
import { HeadlessError, type HeadlessCommand, type HeadlessResult } from "./types.ts";

interface HeadlessOutput {
	write(value: string): unknown;
	on?(event: "error", listener: () => void): unknown;
	off?(event: "error", listener: () => void): unknown;
}

interface SignalHooks {
	once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
	off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface RunHeadlessCommandOptions {
	readonly command: HeadlessCommand;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly stdin: HeadlessInput;
	readonly stdout: HeadlessOutput;
	readonly stderr: HeadlessOutput;
	readonly processHooks: SignalHooks;
	readonly startBackend?: HeadlessBackendFactory;
}

export async function runHeadlessCommand(options: RunHeadlessCommandOptions): Promise<number> {
	const { command } = options;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new HeadlessError("execution_timeout", 124)), command.timeoutMs);
	const interrupt = (): void => { controller.abort(new HeadlessError("interrupted", 130)); };
	const terminate = (): void => { controller.abort(new HeadlessError("terminated", 143)); };
	let outputClosed = false;
	const outputError = (): void => { outputClosed = true; controller.abort(new HeadlessError("output_stream_closed")); };
	options.processHooks.once("SIGINT", interrupt);
	options.processHooks.once("SIGTERM", terminate);
	options.stdout.on?.("error", outputError);
	const emit = (event: Readonly<Record<string, unknown>>): void => {
		if (command.json && !outputClosed) options.stdout.write(`${JSON.stringify({ version: 1, ...event })}\n`);
	};
	let backend: NodeBackend | undefined;
	let result: HeadlessResult = { status: "failed", exit_code: 1, code: "execution_failed" };
	let schema: OutputSchema | undefined;
	let render: ((value: unknown) => string) | undefined;
	try {
		let prompt: string;
		let cwd = options.cwd;
		let reviewRevision: string | undefined;
		let emptyReview = false;
		if (command.kind === "review") {
			const { prepareReview, renderReview } = await import("../review/review.ts");
			const review = await prepareReview({ cwd, target: command.target, instructions: command.instructions, signal: controller.signal });
			prompt = review.prompt;
			cwd = review.workspaceRoot;
			schema = review.schema;
			render = renderReview;
			reviewRevision = review.revision;
			emptyReview = review.empty;
		} else {
			prompt = command.prompt === undefined || command.prompt === "-" ? await readPrompt(options.stdin, controller.signal) : command.prompt;
			if (!prompt.trim()) throw new HeadlessError("prompt_required", 2);
			if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new HeadlessError("prompt_too_large", 2);
			if (command.outputSchema) schema = await loadOutputSchema(resolve(cwd, command.outputSchema), controller.signal);
		}
		controller.signal.throwIfAborted();
		if (emptyReview) {
			result = { status: "completed", exit_code: 0, final_message: JSON.stringify({ summary: "No changes to review.", findings: [] }) };
		} else {
			backend = await (options.startBackend ?? startSupervisedNodeBackend)({
				cwd, env: options.env, args: command.runtimeArgs, signal: controller.signal,
				approvalMode: "suspend",
				...(command.kind === "review" ? { executionMode: "review" } : {}),
				...(reviewRevision ? { reviewRevision } : {}),
			});
			result = await runHeadlessSession({
				backend, prompt: schema ? `${prompt}\n\n${schema.prompt}` : prompt,
				readOnly: command.kind === "review", signal: controller.signal, emit,
			});
		}
		if (result.status === "completed") {
			try {
				const text = result.final_message ?? "";
				if (schema) result = { ...result, structured_output: schema.validate(text) };
				controller.signal.throwIfAborted();
				if (command.outputLastMessage) await writeFinalMessage(resolve(options.cwd, command.outputLastMessage), text);
			} catch (error) {
				const failure = asHeadlessError(error);
				result = { ...result, status: "failed", exit_code: failure.exitCode, code: failure.code };
			}
		}
	} catch (error) {
		const failure = asHeadlessError(controller.signal.aborted ? controller.signal.reason : error);
		result = { status: failure.exitCode === 130 || failure.exitCode === 143 ? "interrupted" : "failed", exit_code: failure.exitCode, code: failure.code };
	} finally {
		clearTimeout(timer);
		if (backend) {
			try { await closeHeadlessBackend(backend); }
			catch { result = { ...result, status: "failed", exit_code: 1, code: "backend_close_failed" }; }
		}
		options.processHooks.off("SIGINT", interrupt);
		options.processHooks.off("SIGTERM", terminate);
	}
	try {
		if (result.status === "completed" && !command.json && !outputClosed) {
			const text = render ? render(result.structured_output) : result.final_message ?? "";
			options.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
		}
		if (result.status !== "completed") {
			options.stderr.write(`[mycli] ${result.message ?? result.code ?? "execution_failed"}${result.session_id ? ` (session ${result.session_id})` : ""}\n`);
			if (result.additional_details) options.stderr.write(`${result.additional_details}\n`);
		}
		emit({ type: "exec.result", ...result });
		if (options.stdout instanceof Writable && !outputClosed) await flushOutput(options.stdout);
		return outputClosed ? 1 : result.exit_code;
	} catch {
		return 1;
	} finally {
		await new Promise<void>((resolve) => setImmediate(resolve));
		options.stdout.off?.("error", outputError);
	}
}

async function flushOutput(output: Writable): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			new Promise<void>((resolve, reject) => output.write("", (error) => error ? reject(error) : resolve())),
			new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new HeadlessError("output_flush_timeout")), 5_000); }),
		]);
	} finally { clearTimeout(timer); }
}

async function closeHeadlessBackend(backend: NodeBackend): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			backend.close(),
			new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { backend.kill(); reject(new HeadlessError("backend_close_timeout")); }, 5_000); }),
		]);
	} finally { clearTimeout(timer); }
}

function asHeadlessError(error: unknown): HeadlessError {
	return error instanceof HeadlessError ? error : new HeadlessError("execution_failed");
}
