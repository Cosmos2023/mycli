import type { Socket } from "node:net";
import type { ConnectionOptions } from "node:tls";
import type { NetworkProxyPolicy } from "@mycli/core";
import type { NetworkAccessDetails } from "@mycli/contracts";
import type { PublicTargetLookup } from "./public-target.ts";
import type { NetworkProxyTarget } from "./proxy-transport.ts";
import { ManagedNetworkProxy } from "./managed-network-proxy.ts";

export type { NetworkProxyTarget } from "./proxy-transport.ts";

export interface NetworkProxyInteraction {
	readonly requestApproval?: (request: NetworkAccessDetails, signal: AbortSignal) => Promise<"approve_once" | "reject" | "unavailable">;
	readonly onBlocked?: (details: NetworkAccessDetails) => void;
}

export interface NetworkProxyOwner {
	readonly sessionId: string;
	readonly turnId?: string;
	readonly callId: string;
}

export interface NetworkProxyOptions extends NetworkProxyInteraction {
	readonly domains: readonly string[];
	readonly policy?: NetworkProxyPolicy;
	readonly sourceEnv?: Readonly<NodeJS.ProcessEnv>;
	readonly lookup?: PublicTargetLookup;
	readonly connect?: (target: NetworkProxyTarget) => Socket;
	/** Host-owned trust; certificate and hostname verification remain mandatory. */
	readonly originCa?: ConnectionOptions["ca"];
	readonly upstreamCa?: ConnectionOptions["ca"];
}

export interface NetworkProxyLease {
	readonly port: number;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly policy?: NetworkProxyPolicy;
	readonly readableRoots?: readonly string[];
	close(): Promise<void>;
}

export async function startNetworkProxy(options: NetworkProxyOptions): Promise<NetworkProxyLease> {
	const proxy = new ManagedNetworkProxy(options);
	try { return await proxy.listen(); }
	catch (error) { await proxy.close(); throw error; }
}
