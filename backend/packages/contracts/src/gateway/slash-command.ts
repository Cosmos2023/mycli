/** Match a registered command boundary without changing whitespace inside its arguments. */
export function slashCommandArguments(text: string, name: string): string | null {
	const normalized = text.trim();
	const prefix = name.trim().split(/\s+/u)
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
		.join("\\s+");
	if (!prefix) return null;
	const match = new RegExp(`^${prefix}(?=\\s|$)`, "u").exec(normalized);
	return match ? normalized.slice(match[0].length).trim() : null;
}
