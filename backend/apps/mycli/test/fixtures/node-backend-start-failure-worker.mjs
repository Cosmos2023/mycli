import { parentPort, workerData } from "node:worker_threads";

// Hold the thread open so a supervisor that forgets to terminate a failed start
// is observable, then exit anyway to keep a regressed run from hanging.
const keepAlive = setInterval(() => undefined, 1_000);
setTimeout(() => {
	clearInterval(keepAlive);
	process.exit(0);
}, 5_000);

parentPort.postMessage({
	type: "start_error",
	generation: workerData.generation,
	message: "node_backend_worker_start_failed",
});
