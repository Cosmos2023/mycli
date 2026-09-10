export function ftsMatchQuery(value: string): string {
	if (typeof value !== "string") return "";
	return value.trim().split(/\s+/u).filter(Boolean)
		.map((token) => `"${token.replaceAll('"', '""')}"`)
		.join(" ");
}

export function searchSnippet(content: string, query: string): string {
	const maximum = 160;
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const lower = content.toLocaleLowerCase();
	const found = normalizedQuery ? lower.indexOf(normalizedQuery) : -1;
	const start = found < 0 ? 0 : Math.max(0, found - Math.floor(maximum / 3));
	const raw = content.slice(start, start + maximum).replace(/\s+/gu, " ").trim();
	const prefix = start > 0 ? "..." : "";
	const suffix = start + maximum < content.length ? "..." : "";
	return `${prefix}${raw}${suffix}`.slice(0, maximum);
}
