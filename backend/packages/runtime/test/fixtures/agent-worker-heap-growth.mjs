import { parentPort, workerData } from "node:worker_threads";

const port = parentPort;
if (!port) throw new Error("agent_worker_requires_parent_port");

let active;
let retained = [];
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
	if (message.type === "grow_heap") {
		retained = Array.from({ length: 750_000 }, (_value, index) => ({ index }));
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
		return;
	}
	if (message.type === "shutdown") {
		active = undefined;
		retained = [];
		port.postMessage({
			type: "stopped",
			workerId: workerData.workerId,
			workerGeneration: workerData.workerGeneration,
		});
		port.close();
	}
});

port.postMessage({
	type: "ready",
	workerId: workerData.workerId,
	workerGeneration: workerData.workerGeneration,
});
