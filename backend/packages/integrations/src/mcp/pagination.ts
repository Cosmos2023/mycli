interface McpDiscoveryPage<Item> {
	readonly items: readonly Item[];
	readonly nextCursor?: string;
}

/** Collect one complete discovery snapshot, never a silently truncated first page. */
export async function collectMcpPages<Item>(
	signal: AbortSignal,
	fetchPage: (cursor?: string) => Promise<McpDiscoveryPage<Item>>,
	errorCode: "invalid_mcp_tool_pagination" | "invalid_mcp_resource_pagination",
): Promise<readonly Item[]> {
	const items: Item[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	let bytes = 0;
	for (let pageCount = 0; pageCount < 100; pageCount += 1) {
		signal.throwIfAborted();
		const page = await fetchPage(cursor);
		signal.throwIfAborted();
		bytes += Buffer.byteLength(JSON.stringify(page.items), "utf8");
		if (items.length + page.items.length > 10_000 || bytes > 8 * 1024 * 1024) throw new Error(errorCode);
		items.push(...page.items);
		cursor = page.nextCursor;
		if (cursor === undefined) return Object.freeze(items);
		if (typeof cursor !== "string" || !cursor || cursor.length > 4_096 || seen.has(cursor)) throw new Error(errorCode);
		seen.add(cursor);
	}
	throw new Error(errorCode);
}
