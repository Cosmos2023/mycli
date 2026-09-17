import type { MycliShellResource } from "../model.ts";
import { boundedUiText } from "../safe-ui-text.ts";
import type { RuntimeShellState } from "./runtime-state-model.ts";

export function mcpStartupStatus(resources: readonly MycliShellResource[]): string[] {
	const servers = resources.filter((resource) => resource.type === "mcp" && resource.enabled !== false);
	const loading = servers.filter((server) => server.status === "loading");
	if (!loading.length) return [];
	const names = loading.slice(0, 3).map((server) => boundedUiText(server.name, "server", 80));
	return [`Starting MCP servers ${servers.length - loading.length}/${servers.length} · ${names.join(", ")}${loading.length > 3 ? ` +${loading.length - 3}` : ""}`];
}

/** Report each failed discovery state once; a successful refresh rearms that server. */
export function runtimeStateWithResources(state: RuntimeShellState, resources: MycliShellResource[]): RuntimeShellState {
	const notices = resources.flatMap((resource) => {
		if (resource.type !== "mcp" || resource.enabled === false || !["failed", "partial"].includes(resource.status ?? "")) return [];
		const previous = state.resources.find((item) => item.id === resource.id);
		if (previous && previous.status === resource.status && previous.detail === resource.detail) return [];
		const name = boundedUiText(resource.name, "server", 100);
		const status = resource.status === "partial" ? "loaded with some capabilities unavailable" : "could not start";
		return [{ id: `mcp-notice:${resource.id}:${state.transcript.length}`, type: "warning", folded: false,
			text: `MCP ${name} ${status}. Open /mcp for details and retry options.` }];
	});
	return { ...state, resources, transcript: [...state.transcript, ...notices] };
}
