import { parentPort, workerData } from "node:worker_threads";

const port = parentPort;
if (!port) throw new Error("agent_worker_requires_parent_port");

let active;
port.on("message", (message) => {
	if (message.type === "lease") {
		active = { leaseId: message.leaseId, jobId: message.jobId };
		port.postMessage({
			type: "leased",
			workerId: workerData.workerId,
			workerGeneration: workerData.workerGeneration,
			leaseId: message.leaseId,
			jobId: message.jobId,
		});
		return;
	}
	if (message.type === "emit_late") {
		setTimeout(() => port.postMessage({ type: "malformed_late_frame" }), 10);
		return;
	}
	if (message.type === "shutdown") {
		active = undefined;
		port.postMessage({
			type: "stopped",
			workerId: workerData.workerId,
			workerGeneration: workerData.workerGeneration,
		});
		port.close();
		return;
	}
	if (message.type === "release" && active
		&& message.leaseId === active.leaseId && message.jobId === active.jobId) {
		active = undefined;
		port.postMessage({
			type: "released",
			workerId: workerData.workerId,
			workerGeneration: workerData.workerGeneration,
			leaseId: message.leaseId,
			jobId: message.jobId,
		});
	}
});

port.postMessage({
	type: "ready",
	workerId: workerData.workerId,
	workerGeneration: workerData.workerGeneration,
});
