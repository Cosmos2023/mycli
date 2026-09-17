export interface SessionTrainingExportSettings {
	/** Omitted by /export to generate a new JSONL filename in the current workspace. */
	readonly outputPath?: string;
}

/** CLI and slash export the same single conversation JSONL row. */
export function parseTrainingExportSettings(args: readonly string[]): SessionTrainingExportSettings | undefined {
	let training = false;
	let outputPath: string | undefined;
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index]!;
		if (seen.has(flag)) return undefined;
		seen.add(flag);
		if (flag === "--training") training = true;
		else if (flag === "--output") {
			const value = args[++index];
			if (!value?.trim() || value.startsWith("--") || value.includes("\0")) return undefined;
			outputPath = value;
		} else return undefined;
	}
	return training && outputPath ? Object.freeze({ outputPath }) : undefined;
}
