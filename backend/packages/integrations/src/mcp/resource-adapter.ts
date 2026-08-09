import type {
	McpResourceClientContract,
	McpResourceContent,
	McpResourceDescriptor,
} from "./types.ts";

export class McpResourceAdapter {
	readonly #clients: ReadonlyMap<string, McpResourceClientContract>;

	constructor(clients: ReadonlyMap<string, McpResourceClientContract>) {
		this.#clients = new Map(clients);
	}

	async listResources(signal: AbortSignal): Promise<readonly McpResourceDescriptor[]> {
		const resources: McpResourceDescriptor[] = [];
		for (const [, client] of [...this.#clients].sort(([left], [right]) => compareText(left, right))) {
			if (signal.aborted) throw abortError();
			resources.push(...await client.listResources(signal));
		}
		return Object.freeze(resources);
	}

	async readResource(
		serverId: string,
		uri: string,
		signal: AbortSignal,
	): Promise<readonly McpResourceContent[]> {
		const client = this.#clients.get(serverId);
		if (!client) throw new Error("unknown_mcp_server");
		if (signal.aborted) throw abortError();
		return client.readResource(uri, signal);
	}
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}
