import { parentPort, workerData } from "node:worker_threads";
import {
	startNodeBackend,
	type NodeBackend,
	type StartNodeBackendOptions,
} from "./node-backend.ts";

interface BackendWorkerData {
	readonly generation: number;
	readonly options: StartNodeBackendOptions;
}

type ParentMessage =
	| { readonly type: "input"; readonly chunk: string }
	| { readonly type: "close" };

const port = parentPort;
if (!port) throw new Error("node_backend_worker_requires_parent_port");

const data = workerData as BackendWorkerData;
let backend: NodeBackend | undefined;
let completionSent = false;

function sendCompletion(code: number): void {
	if (completionSent) return;
	completionSent = true;
	port!.postMessage({ type: "completion", generation: data.generation, code });
}

function finish(code: number): void {
	sendCompletion(code);
	port!.close();
}

try {
	backend = await startNodeBackend(data.options);
	backend.transport.input.on("data", (chunk: Buffer | string) => {
		port.postMessage({
			type: "output",
			generation: data.generation,
			chunk: typeof chunk === "string" ? chunk : chunk.toString("utf8"),
		});
	});
	backend.transport.input.on("error", () => {
		void backend?.close().finally(() => finish(1));
	});
	port.on("message", (message: ParentMessage) => {
		if (message.type === "input") {
			backend?.transport.output.write(message.chunk);
			return;
		}
		void backend?.close().catch(() => finish(1));
	});
	void backend.completion.then(finish, () => finish(1));
	await new Promise<void>((resolve) => setImmediate(resolve));
	port.postMessage({ type: "started", generation: data.generation });
} catch {
	port.postMessage({
		type: "start_error",
		generation: data.generation,
		message: "node_backend_worker_start_failed",
	});
	port.close();
}
