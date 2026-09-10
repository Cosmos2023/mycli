import { parentPort, workerData } from "node:worker_threads";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import {
	GatewayWriteQueue, GatewayFlowControlError, gatewayLimits, isGatewayControlMethod, type GatewayFlowControlLimits,
} from "@mycli/gateway/flow-control";
import {
	startNodeBackend,
	type NodeBackend,
	type StartNodeBackendOptions,
} from "./node-backend.ts";

interface BackendWorkerData {
	readonly generation: number;
	readonly options: StartNodeBackendOptions;
	readonly limits?: Partial<GatewayFlowControlLimits>;
}

const port = parentPort;
if (!port) throw new Error("node_backend_worker_requires_parent_port");

const data = workerData as BackendWorkerData;
let backend: NodeBackend | undefined;
let completionSent = false;
let failing = false;
let failureCode = "";
const limits = gatewayLimits(data.limits);
let inputQueue: GatewayWriteQueue | undefined;
let outputSequence = 0;
let inputSequence = 0;
let acknowledgeOutput: (() => void) | undefined;
const output = new Writable({
	highWaterMark: 1,
	write(chunk: Buffer, _encoding, callback): void {
		acknowledgeOutput = () => { acknowledgeOutput = undefined; callback(); };
		port!.postMessage({ type: "output", generation: data.generation, sequence: ++outputSequence, chunk: chunk.toString("utf8") });
	},
});
const outputFinished = finished(output).then(() => true, () => false);

function sendCompletion(code: number): void {
	if (completionSent) return;
	completionSent = true;
	port!.postMessage({ type: "completion", generation: data.generation, code, diagnostic: backend?.diagnostic() || failureCode });
}

function finish(code: number): void {
	inputQueue?.dispose();
	output.destroy();
	sendCompletion(code);
	port!.close();
}

function fail(error?: Error): void {
	if (failing || completionSent) return;
	failing = true;
	failureCode = error instanceof GatewayFlowControlError ? error.code : "node_backend_transport_failed";
	inputQueue?.dispose();
	output.destroy();
	void backend?.close().then(() => finish(1), () => finish(1));
}

try {
	backend = await startNodeBackend(data.options);
	inputQueue = new GatewayWriteQueue(backend.transport.output, limits, fail);
	backend.transport.input.on("error", fail);
	backend.transport.input.on("close", () => {
		if (!(backend!.transport.input as { readableEnded?: boolean }).readableEnded) fail();
	});
	output.on("error", fail);
	port.on("message", (message: unknown) => {
		if (typeof message !== "object" || message === null) { fail(); return; }
		const envelope = message as Record<string, unknown>;
		if (envelope.type === "close") {
			void backend?.close().catch(fail);
			return;
		}
		if (envelope.generation !== data.generation) return;
		if (envelope.type === "output_ack") {
			if (envelope.sequence === outputSequence) acknowledgeOutput?.();
			return;
		}
		if (envelope.type === "input") {
			if (typeof envelope.chunk !== "string" || envelope.sequence !== inputSequence + 1) { fail(); return; }
			inputSequence++;
			try {
				if (Buffer.byteLength(envelope.chunk) > limits.maxFrameBytes + 1) { fail(); return; }
				const request = JSON.parse(envelope.chunk) as { method?: unknown };
				inputQueue!.enqueue(envelope.chunk, {
					control: typeof request.method === "string" && isGatewayControlMethod(request.method),
					onWritten: () => { port.postMessage({ type: "input_ack", generation: data.generation, sequence: envelope.sequence }); },
				});
			} catch (error) { fail(error instanceof Error ? error : undefined); }
			return;
		}
		fail();
	});
	backend.transport.input.pipe(output);
	void backend.completion.then(async (code) => {
		let timer: NodeJS.Timeout | undefined;
		const drained = await Promise.race([
			outputFinished,
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), limits.writeStallTimeoutMs);
				timer.unref();
			}),
		]);
		clearTimeout(timer);
		finish(drained ? code : 1);
	}, () => finish(1));
	await new Promise<void>((resolve) => setImmediate(resolve));
	port.postMessage({
		type: "started",
		generation: data.generation,
		startupProfile: backend.startupProfile?.(),
	});
} catch {
	port.postMessage({
		type: "start_error",
		generation: data.generation,
		message: "node_backend_worker_start_failed",
	});
	port.close();
}
