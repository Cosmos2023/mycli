import { finished } from "node:stream/promises";
import { DEFAULT_GATEWAY_LIMITS } from "@mycli/gateway";
import type { NodeBackend, StartNodeBackendOptions } from "../node-runtime/node-backend.ts";
import { startSupervisedNodeBackend } from "../node-runtime/node-backend-supervisor.ts";
import { BackendService, type BackendClientAttachment } from "./backend-service.ts";

interface SignalSource {
	once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
	off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface StdioAppServerOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly args: readonly string[];
	readonly input: NodeJS.ReadableStream;
	readonly output: NodeJS.WritableStream;
	readonly stderr: { write(text: string): unknown };
	readonly processHooks: SignalSource;
	readonly startBackend?: (options: StartNodeBackendOptions) => NodeBackend | Promise<NodeBackend>;
}

export async function runStdioAppServer(options: StdioAppServerOptions): Promise<number> {
	const controller = new AbortController();
	const drainController = new AbortController();
	let backend: NodeBackend | undefined;
	let service: BackendService | undefined;
	let connection: BackendClientAttachment | undefined;
	let outputDrained: Promise<boolean> | undefined;
	let exitCode = 1;
	let stopCode: number | undefined;
	let resolveStop!: (code: number) => void;
	const stopped = new Promise<number>((resolve) => { resolveStop = resolve; });
	const stop = (code: number): void => {
		if (stopCode !== undefined) return;
		stopCode = code;
		controller.abort(new Error("app_server_stopped"));
		resolveStop(code);
	};
	const eof = (): void => { stop(0); };
	const failed = (): void => { stop(1); };
	const interrupted = (): void => { stop(130); };
	const terminated = (): void => { stop(143); };
	options.input.once("end", eof);
	options.input.once("close", eof);
	options.input.on("error", failed);
	options.output.on("error", failed);
	options.output.once("close", failed);
	options.processHooks.once("SIGINT", interrupted);
	options.processHooks.once("SIGTERM", terminated);
	try {
		const inputState = options.input as { readableEnded?: boolean; destroyed?: boolean };
		const outputState = options.output as { writableEnded?: boolean; destroyed?: boolean };
		if (inputState.readableEnded || inputState.destroyed) return 0;
		if (outputState.writableEnded || outputState.destroyed) return 1;
		backend = await (options.startBackend ?? startSupervisedNodeBackend)({
			cwd: options.cwd, env: options.env, args: options.args, signal: controller.signal,
		});
		if (stopCode !== undefined) return stopCode;
		service = new BackendService(backend);
		connection = service.attach({ role: "controller" });
		void connection.completion.then(() => {
			if (service?.snapshot().state === "running") failed();
		});
		connection.transport.input.on("error", failed);
		connection.transport.output.on("error", failed);
		outputDrained = drainStdioOutput(connection.transport.input, options.output, drainController.signal);
		connection.transport.input.pipe(options.output, { end: false });
		options.input.pipe(connection.transport.output, { end: false });
		exitCode = await Promise.race([service.completion, stopped]);
	} catch {
		if (stopCode !== undefined) exitCode = stopCode;
		else options.stderr.write("[mycli] app_server_failed: backend connection failed\n");
	} finally {
		controller.abort();
		if (backend) {
			if (connection) options.input.unpipe(connection.transport.output);
			const drainTimer = setTimeout(() => drainController.abort(), DEFAULT_GATEWAY_LIMITS.writeStallTimeoutMs);
			drainTimer.unref();
			try { if (service) await service.close(); else await backend.close(); }
			catch { backend.kill(); if (exitCode === 0) exitCode = 1; }
			if (exitCode === 0 && outputDrained && !await outputDrained) exitCode = 1;
			clearTimeout(drainTimer);
			connection?.transport.input.unpipe(options.output);
			connection?.transport.input.off("error", failed);
			connection?.transport.output.off("error", failed);
		}
		drainController.abort();
		options.input.off("end", eof);
		options.input.off("close", eof);
		options.input.off("error", failed);
		options.output.off("error", failed);
		options.output.off("close", failed);
		options.processHooks.off("SIGINT", interrupted);
		options.processHooks.off("SIGTERM", terminated);
	}
	return exitCode;
}

async function drainStdioOutput(
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
	signal: AbortSignal,
): Promise<boolean> {
	try {
		await finished(input, { readable: true, writable: false, cleanup: true, signal });
		if (signal.aborted) return false;
		return await new Promise<boolean>((resolve) => {
			const aborted = (): void => resolve(false);
			signal.addEventListener("abort", aborted, { once: true });
			try {
				// All source bytes have entered the destination; the callback fences prior writes.
				output.write("", (error?: Error | null) => {
					signal.removeEventListener("abort", aborted);
					resolve(!error);
				});
			} catch {
				signal.removeEventListener("abort", aborted);
				resolve(false);
			}
		});
	} catch { return false; }
}
