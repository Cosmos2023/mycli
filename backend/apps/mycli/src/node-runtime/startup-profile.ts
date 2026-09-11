import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type StartupProfileStage =
	| "module_ready"
	| "backend_ready"
	| "tui_ready"
	| "runtime_entered"
	| "config_ready"
	| "storage_ready"
	| "runtime_components_ready"
	| "integration_discovery_started"
	| "hooks_ready"
	| "skills_ready"
	| "mcp_cache_ready"
	| "plugins_ready"
	| "subagents_ready"
	| "integrations_ready"
	| "session_prepare_started"
	| "session_prepared"
	| "trust_ready"
	| "session_ready"
	| "gateway_ready";

interface StartupProfileMark {
	readonly stage: StartupProfileStage;
	readonly elapsedMs: number;
}

export interface StartupProfileSnapshot {
	readonly scope: "cli" | "backend";
	readonly marks: readonly StartupProfileMark[];
}

export class StartupProfiler {
	readonly #enabled: boolean;
	readonly #scope: StartupProfileSnapshot["scope"];
	readonly #origin: number;
	readonly #clock: () => number;
	readonly #marks: StartupProfileMark[] = [];

	constructor(options: {
		readonly enabled: boolean;
		readonly scope: StartupProfileSnapshot["scope"];
		readonly origin?: number;
		readonly clock?: () => number;
	}) {
		this.#enabled = options.enabled;
		this.#scope = options.scope;
		this.#clock = options.clock ?? (() => performance.now());
		this.#origin = options.origin ?? this.#clock();
	}

	mark(stage: StartupProfileStage): void {
		if (!this.#enabled) return;
		this.#marks.push(Object.freeze({
			stage,
			elapsedMs: Math.max(0, Math.round(this.#clock() - this.#origin)),
		}));
	}

	snapshot(): StartupProfileSnapshot | undefined {
		if (!this.#enabled) return undefined;
		return Object.freeze({
			scope: this.#scope,
			marks: Object.freeze([...this.#marks]),
		});
	}
}

export function startupProfileEnabled(env: NodeJS.ProcessEnv): boolean {
	return env.MYCLI_STARTUP_PROFILE === "1";
}

export async function writeStartupProfile(options: {
	readonly homeDir: string;
	readonly profiles: readonly StartupProfileSnapshot[];
}): Promise<void> {
	if (options.profiles.length === 0) return;
	const directory = join(options.homeDir, ".mycli", "logs");
	const target = join(directory, "startup-profile.json");
	const temporary = join(directory, `.startup-profile.${process.pid}.tmp`);
	const content = `${JSON.stringify({
		schema_version: 1,
		profiles: options.profiles,
	})}\n`;
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700).catch(() => undefined);
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, target);
		await chmod(target, 0o600).catch(() => undefined);
	} catch {
		// Startup profiling is best-effort and cannot affect CLI availability.
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}
