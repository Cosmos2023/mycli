export type RuntimeBackend = "python-sidecar" | "node";

export function selectRuntimeBackend(options: {
	argv: readonly string[];
	env: NodeJS.ProcessEnv;
}): RuntimeBackend {
	const cliValues = backendArguments(options.argv);
	const uniqueValues = new Set(cliValues);
	if (uniqueValues.size > 1) {
		throw new Error("runtime_backend_conflict: multiple runtime backends were selected");
	}

	const selected = cliValues[0] ?? options.env.MYCLI_RUNTIME_BACKEND?.trim() ?? "python-sidecar";
	if (selected === "python-sidecar" || selected === "") {
		return "python-sidecar";
	}
	if (selected === "node") {
		return "node";
	}
	throw new Error("runtime_backend_invalid: unknown runtime backend");
}

function backendArguments(argv: readonly string[]): string[] {
	const values: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--runtime-backend") {
			const value = argv[index + 1];
			if (value === undefined) {
				throw new Error("runtime_backend_invalid: --runtime-backend requires a value");
			}
			values.push(value);
			index += 1;
		} else if (argument?.startsWith("--runtime-backend=")) {
			const value = argument.slice("--runtime-backend=".length);
			if (!value) {
				throw new Error("runtime_backend_invalid: --runtime-backend requires a value");
			}
			values.push(value);
		}
	}
	return values;
}
