export interface GatewayTransport {
	readonly input: NodeJS.ReadableStream;
	readonly output: NodeJS.WritableStream;
	readonly close?: () => void | Promise<void>;
	readonly diagnostic?: () => string;
}
