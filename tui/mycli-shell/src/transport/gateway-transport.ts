import process from "node:process";
import type { GatewayTransport } from "@mycli/gateway";
export type { GatewayTransport } from "@mycli/gateway";

const defaultTransport: GatewayTransport = {
	input: process.stdin,
	output: process.stdout,
};

let configuredTransport: GatewayTransport | null = null;
let closePromise: Promise<void> | null = null;

export function configureGatewayTransport(transport: GatewayTransport): void {
	if (configuredTransport !== null) {
		throw new Error("Gateway transport is already configured.");
	}
	configuredTransport = transport;
}

export function gatewayTransport(): GatewayTransport {
	return configuredTransport ?? defaultTransport;
}

export async function closeGatewayTransport(): Promise<void> {
	if (closePromise !== null) {
		return closePromise;
	}
	const close = configuredTransport?.close;
	closePromise = Promise.resolve(close?.()).then(() => undefined);
	return closePromise;
}
