import { IntegrationEnablementStore, integrationEnabled, integrationSourceIdentity, type IntegrationEnablementSnapshot } from "../foundation/enablement-store.ts";
import { HookAllowlistStore, hookIdentity } from "./allowlist.ts";
import type { HookRegistration } from "./manager.ts";
import type { ConfiguredHookSpec } from "./types.ts";

export interface HookBrowserRow {
	readonly id: string;
	readonly revision: string;
	readonly name: string;
	readonly point: string;
	readonly source: string;
	readonly path: string;
	readonly command: readonly string[];
	readonly enabled: boolean;
	readonly trusted: boolean;
	readonly trustSource: "allowlist" | "plugin";
	readonly timeoutMs?: number;
}

export interface HookBrowserSnapshot {
	readonly revision: string;
	readonly hooks: readonly HookBrowserRow[];
}

export function configuredHookIdentity(spec: ConfiguredHookSpec): string {
	return integrationSourceIdentity(["hook", spec.configPath, hookIdentity(spec)]);
}

export function pluginHookIdentity(hook: Pick<HookRegistration, "id" | "hookPoint" | "origin">): string {
	return integrationSourceIdentity(["hook", hook.origin?.path ?? "plugin", hook.id, hook.hookPoint]);
}

export function configuredHookEnablement(spec: ConfiguredHookSpec, settings: IntegrationEnablementSnapshot): ConfiguredHookSpec {
	return { ...spec, enabled: integrationEnabled(settings, "hook", configuredHookIdentity(spec), spec.enabled) };
}

export class HookSelectionError extends Error {
	constructor() { super("The hook or its configuration changed. Refresh /hooks and retry."); this.name = "HookSelectionError"; }
}

export class HookBrowserService {
	readonly #store: IntegrationEnablementStore;
	readonly #allowlist: HookAllowlistStore;

	constructor(private readonly options: {
		readonly homeDir: string;
		readonly configured: () => Promise<readonly ConfiguredHookSpec[]>;
		readonly plugins: () => readonly HookRegistration[];
	}) {
		this.#store = new IntegrationEnablementStore(options);
		this.#allowlist = new HookAllowlistStore(options);
	}

	async list(): Promise<HookBrowserSnapshot> { return (await this.load()).snapshot; }

	async write(input: {
		readonly id: string;
		readonly revision: string;
		readonly hookRevision: string;
		readonly action: "enable" | "disable" | "trust" | "revoke";
	}, signal: AbortSignal): Promise<HookBrowserSnapshot> {
		signal.throwIfAborted();
		const { snapshot, specs } = await this.load();
		const row = snapshot.hooks.find((hook) => hook.id === input.id);
		if (!row || snapshot.revision !== input.revision || row.revision !== input.hookRevision) throw new HookSelectionError();
		signal.throwIfAborted();
		if (input.action === "enable" || input.action === "disable") {
			await this.#store.setEnabled({ kind: "hook", id: row.id, enabled: input.action === "enable", revision: input.revision }, signal);
		} else {
			const spec = specs.find((hook) => configuredHookIdentity(hook) === input.id);
			if (!spec || row.trustSource === "plugin") throw new HookSelectionError();
			if (input.action === "trust") await this.#allowlist.approve(spec, signal);
			else await this.#allowlist.revoke(spec, signal);
		}
		return this.list();
	}

	private async load(): Promise<{ readonly snapshot: HookBrowserSnapshot; readonly specs: readonly ConfiguredHookSpec[] }> {
		const [settings, specs] = await Promise.all([this.#store.load(), this.options.configured()]);
		const rows = await Promise.all(specs.map(async (spec): Promise<HookBrowserRow> => {
			const approval = await this.#allowlist.statusFor(spec);
			const id = configuredHookIdentity(spec);
			return { id, revision: integrationSourceIdentity([id, JSON.stringify(spec), String(approval.allowed)]),
				name: spec.hookId, point: spec.hookPoint, source: spec.scope, path: spec.configPath,
				command: [...spec.command], enabled: integrationEnabled(settings, "hook", id, spec.enabled),
				trusted: approval.allowed, trustSource: "allowlist", timeoutMs: spec.timeoutMs,
			};
		}));
		for (const hook of this.options.plugins()) {
			const id = pluginHookIdentity(hook);
			rows.push({ id, revision: integrationSourceIdentity([id, JSON.stringify(hook.origin ?? {})]),
				name: hook.id, point: hook.hookPoint, source: hook.origin?.pluginId ?? "plugin", path: hook.origin?.path ?? "",
				command: [...(hook.origin?.command ?? [])], enabled: integrationEnabled(settings, "hook", id, hook.origin?.enabled ?? true),
				trusted: true, trustSource: "plugin",
			});
		}
		rows.sort((a, b) => a.point.localeCompare(b.point) || a.name.localeCompare(b.name));
		return { specs, snapshot: { revision: settings.revision, hooks: rows } };
	}
}
