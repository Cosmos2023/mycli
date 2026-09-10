import type { ErrorReason } from "./catalog.ts";

export const LOCAL_CONNECTION_REASONS = Object.freeze({
	gateway_overloaded: "gateway.output_capacity_exceeded",
	gateway_output_stalled: "transport.output_stalled",
	gateway_message_too_large: "gateway.message_too_large",
	node_backend_worker_exited: "runtime.worker_exited",
	node_backend_worker_failed: "runtime.worker_exited",
	node_backend_worker_start_failed: "runtime.worker_exited",
	node_backend_worker_restart_failed: "runtime.worker_exited",
	node_backend_invalid_output_sequence: "gateway.protocol_incompatible",
	node_backend_invalid_output: "gateway.protocol_incompatible",
	node_backend_transport_failed: "transport.gateway_disconnected",
	pipe_closed: "transport.gateway_disconnected",
	gateway_closed: "transport.gateway_disconnected",
} satisfies Readonly<Record<string, ErrorReason>>);

export function localConnectionReason(code: string | undefined): ErrorReason {
	return code && Object.hasOwn(LOCAL_CONNECTION_REASONS, code)
		? LOCAL_CONNECTION_REASONS[code as keyof typeof LOCAL_CONNECTION_REASONS] : "transport.gateway_disconnected";
}

export function storageErrorReason(code: string | undefined): Extract<ErrorReason, `storage.${string}`> {
	if (code?.startsWith("SQLITE_BUSY") || code?.startsWith("SQLITE_LOCKED")) return "storage.busy";
	if (code === "SQLITE_FULL" || code === "ENOSPC" || code === "EDQUOT") return "storage.capacity_exceeded";
	if (code?.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB") return "storage.data_invalid";
	if (code?.startsWith("SQLITE_IOERR") || code?.startsWith("SQLITE_READONLY")
		|| code === "EACCES" || code === "EROFS") return "storage.write_failed";
	return "storage.failure_unclassified";
}
