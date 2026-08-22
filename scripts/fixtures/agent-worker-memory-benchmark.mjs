import { parentPort, workerData } from "node:worker_threads";

const port = parentPort;
if (!port) throw new Error("agent_worker_requires_parent_port");

let active;
let retainedPayload;

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
	if (message.type === "retain_payload" && active) {
		retainedPayload = message.payload;
		port.postMessage({
			type: "payload_retained",
			workerId: workerData.workerId,
			workerGeneration: workerData.workerGeneration,
			leaseId: active.leaseId,
			jobId: active.jobId,
			kind: message.kind,
		});
		return;
	}
	if (message.type === "release" && active
		&& message.leaseId === active.leaseId && message.jobId === active.jobId) {
		active = undefined;
		retainedPayload = undefined;
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
		retainedPayload = undefined;
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
