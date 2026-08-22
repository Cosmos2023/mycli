export interface AgentWorkerSettings {
	readonly maxWorkers: number;
	readonly idleTimeoutMs: number;
}

const DEFAULT_AGENT_WORKER_MAX = 4;
const MIN_AGENT_WORKER_MAX = 2;
const MAX_AGENT_WORKER_MAX = 4;
const DEFAULT_AGENT_WORKER_IDLE_TIMEOUT_MS = 30_000;
const MIN_AGENT_WORKER_IDLE_TIMEOUT_MS = 1_000;
const MAX_AGENT_WORKER_IDLE_TIMEOUT_MS = 600_000;

export function resolveAgentWorkerSettings(env: NodeJS.ProcessEnv): AgentWorkerSettings {
	return Object.freeze({
		maxWorkers: boundedEnvironmentInteger(
			env.MYCLI_AGENT_WORKER_MAX,
			"MYCLI_AGENT_WORKER_MAX",
			DEFAULT_AGENT_WORKER_MAX,
			MIN_AGENT_WORKER_MAX,
			MAX_AGENT_WORKER_MAX,
		),
		idleTimeoutMs: boundedEnvironmentInteger(
			env.MYCLI_AGENT_WORKER_IDLE_TIMEOUT_MS,
			"MYCLI_AGENT_WORKER_IDLE_TIMEOUT_MS",
			DEFAULT_AGENT_WORKER_IDLE_TIMEOUT_MS,
			MIN_AGENT_WORKER_IDLE_TIMEOUT_MS,
			MAX_AGENT_WORKER_IDLE_TIMEOUT_MS,
		),
	});
}

function boundedEnvironmentInteger(
	rawValue: string | undefined,
	name: string,
	defaultValue: number,
	minimum: number,
	maximum: number,
): number {
	if (rawValue === undefined || rawValue.trim() === "") return defaultValue;
	const value = rawValue.trim();
	if (!/^[1-9]\d*$/u.test(value)) {
		throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
	}
	return parsed;
}
