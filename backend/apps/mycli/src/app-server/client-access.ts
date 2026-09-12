import type { GatewayMethod } from "@mycli/contracts";

export type BackendClientRole = "controller" | "observer";

const OBSERVER_METHODS: ReadonlySet<string> = new Set<GatewayMethod>([
	"initialize", "session.bootstrap", "status.get", "status.inspect",
	"session.list", "session.resume.preview", "session.tree", "transcript.load",
	"provider.attempts.load",
	"workspace.trust.status", "permissions.list", "provider.list", "model.list",
	"settings.load", "update.status", "command.list", "completion.slash",
	"completion.path", "resource.list", "extension.manifest", "shell.list",
	"plugin.catalog", "plugin.inspect", "plugin.operation.get",
	"shell.output.load", "trace.export",
]);

export function isObserverMethod(method: string): boolean {
	return OBSERVER_METHODS.has(method);
}

const FAILURE_MESSAGES = {
	service_closed: "Backend service is closed.",
	client_limit_exceeded: "Backend service client capacity exceeded.",
	controller_attached: "Backend service already has a controller.",
	controller_draining: "The previous controller still has accepted operations in flight.",
	read_only_client: "This backend client has read-only access.",
	client_detached: "Backend client is detached.",
} as const;

export class BackendServiceError extends Error {
	constructor(readonly code: keyof typeof FAILURE_MESSAGES) {
		super(FAILURE_MESSAGES[code]);
		this.name = "BackendServiceError";
	}
}
