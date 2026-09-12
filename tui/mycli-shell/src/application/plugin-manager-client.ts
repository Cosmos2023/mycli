import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { GatewayMethod, GatewayParams, GatewayResult } from "@mycli/contracts";
import type { MycliShellPluginManager } from "../model.ts";

export function createPluginManagerClient(options: {
	readonly request: <M extends GatewayMethod>(method: M, params: GatewayParams<M>) => Promise<GatewayResult<M>>;
	readonly context: () => Pick<GatewayParams<"plugin.catalog">, "session_id" | "generation">;
	readonly pollMs?: number;
}): MycliShellPluginManager {
	return {
		inspect: async (plugin, signal) => {
			signal.throwIfAborted();
			const result = await options.request("plugin.inspect", { ...options.context(), target: plugin.id, revision: plugin.revision });
			signal.throwIfAborted();
			return result;
		},
		load: async (signal, marketplace) => {
			signal.throwIfAborted();
			const result = await options.request("plugin.catalog", { ...options.context(), ...(marketplace ? { marketplace } : {}) });
			signal.throwIfAborted();
			return result;
		},
		change: async (change, signal) => {
			signal.throwIfAborted();
			const ownership = { ...options.context(), operation_id: randomUUID() };
			const started = options.request("plugin.operation.start", { ...ownership, change });
			const cancel = (): void => { void options.request("plugin.operation.cancel", ownership).catch(() => undefined); };
			signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) cancel();
			try {
				let result = await started;
				while (result.state === "running") {
					await delay(options.pollMs ?? 250, undefined, { signal });
					result = await options.request("plugin.operation.get", ownership);
				}
				return result;
			} finally { signal.removeEventListener("abort", cancel); }
		},
	};
}
