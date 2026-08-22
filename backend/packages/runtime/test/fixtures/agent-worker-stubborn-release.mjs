import { parentPort, workerData } from "node:worker_threads";

parentPort.on("message", (message) => {
	if (message.type !== "lease") return;
	parentPort.postMessage({
		type: "leased",
		workerId: workerData.workerId,
		workerGeneration: workerData.workerGeneration,
		leaseId: message.leaseId,
		jobId: message.jobId,
	});
});

parentPort.postMessage({
	type: "ready",
	workerId: workerData.workerId,
	workerGeneration: workerData.workerGeneration,
});
