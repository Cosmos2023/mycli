export class ProcessSandboxError extends Error {
	constructor(
		readonly kind: "sandbox_unavailable" | "network_proxy_unavailable",
		message = "Required process sandbox is unavailable.",
	) {
		super(message);
		this.name = "ProcessSandboxError";
	}
}
