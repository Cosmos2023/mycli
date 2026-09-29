const TRANSFORM_TYPES_FLAG = "--experimental-transform-types";
const DISABLE_EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";

/**
 * Source (`mycli-source`) workers are `.ts` files. Worker threads do run `--import` preloads,
 * but ESM hooks registered through `module.register()` stay on the loader of the thread that
 * registered them; that is how tsx registers on Node 22 before 22.22.3 and Node 24 before
 * 24.11.1. Such a worker falls back to Node's own TypeScript support, and strip-only mode
 * rejects syntax this repository uses (parameter properties).
 *
 * `NODE_OPTIONS` is the per-worker channel that survives `execArgv` validation, so a source
 * worker asks for Node's transform pipeline through the environment it is spawned with.
 * Returns `undefined` when the worker can inherit the parent environment unchanged.
 */
export function sourceWorkerNodeOptions(
	workerUrl: URL,
	env: Readonly<NodeJS.ProcessEnv> = process.env,
): string | undefined {
	if (workerUrl.protocol !== "file:" || !workerUrl.pathname.endsWith(".ts")) return undefined;
	if (!process.allowedNodeEnvironmentFlags.has(TRANSFORM_TYPES_FLAG)) return undefined;
	const inherited = env.NODE_OPTIONS?.trim() ?? "";
	const inheritedFlags = inherited.split(/\s+/u).filter(Boolean);
	if (inheritedFlags.includes(TRANSFORM_TYPES_FLAG)) return undefined;
	const flags = [TRANSFORM_TYPES_FLAG];
	if (process.allowedNodeEnvironmentFlags.has(DISABLE_EXPERIMENTAL_WARNING_FLAG)) {
		flags.push(DISABLE_EXPERIMENTAL_WARNING_FLAG);
	}
	return [...inheritedFlags, ...flags].join(" ");
}
