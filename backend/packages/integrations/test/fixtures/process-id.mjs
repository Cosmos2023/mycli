import { readFile } from "node:fs/promises";

export async function observableProcessId() {
	if (process.platform !== "linux") return process.pid;
	try {
		const status = await readFile("/proc/self/status", "utf8");
		const namespaceIds = /^NSpid:[ \t]+([0-9 \t]+)$/mu.exec(status)?.[1]?.trim();
		const outermost = Number(namespaceIds?.split(/\s+/u)[0]);
		return Number.isSafeInteger(outermost) && outermost > 0 ? outermost : process.pid;
	} catch {
		return process.pid;
	}
}
