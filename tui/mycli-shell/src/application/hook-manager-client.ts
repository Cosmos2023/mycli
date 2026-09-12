import type { GatewayMethod, GatewayParams, GatewayResult } from "@mycli/contracts";
import type { MycliShellHookManager } from "../model.ts";

export function createHookManagerClient(options: {
 readonly request: <M extends GatewayMethod>(method: M, params: GatewayParams<M>) => Promise<GatewayResult<M>>;
 readonly context: () => GatewayParams<"hooks.list">;
}): MycliShellHookManager {
 return {
  load: async (signal) => {
   signal.throwIfAborted();
   const result = await options.request("hooks.list", options.context());
   signal.throwIfAborted();
   return result;
  },
  write: async (hook, action, revision, signal) => {
   signal.throwIfAborted();
   const result = await options.request("hooks.config.write", { ...options.context(), id: hook.id, hook_revision: hook.revision, revision, action });
   signal.throwIfAborted();
   return result;
  },
 };
}
