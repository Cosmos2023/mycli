import {
	startNodeBackend,
	type StartNodeBackendOptions,
} from "../../src/node-runtime/node-backend.ts";

export const offlineUpdateFetch: typeof fetch = async () => {
	throw new TypeError("test update registry is offline");
};

export function startTestNodeBackend(
	options: StartNodeBackendOptions,
): ReturnType<typeof startNodeBackend> {
	return startNodeBackend({ updateFetch: offlineUpdateFetch, ...options });
}
