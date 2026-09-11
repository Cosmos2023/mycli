import { HookAllowlistStore, hookCommandDigest, hookConfigPathHash, hookIdentity } from "./allowlist.ts";
import { discoverHookConfig } from "./config.ts";
import type { DiscoverHookConfigOptions } from "./config.ts";
import type {
	ConfiguredHookSpec,
	HookApprovalStatus,
	HookConfigDiagnostic,
} from "./types.ts";

export interface HookManagementRow {
	readonly scope: ConfiguredHookSpec["scope"];
	readonly hookId: string;
	readonly hookPoint: ConfiguredHookSpec["hookPoint"];
	readonly identity: string;
	readonly enabled: boolean;
	readonly timeoutMs: number;
	readonly workingDirectory: ConfiguredHookSpec["workingDirectory"];
	readonly envPolicy: ConfiguredHookSpec["envPolicy"];
	readonly shellKind?: ConfiguredHookSpec["shellKind"];
	readonly commandDigest: string;
	readonly configPathHash: string;
	readonly allowlistStatus: "allowed" | "not_allowed";
	readonly allowlistReason: HookApprovalStatus["reason"];
}

export interface HookManagementResponse {
	readonly ok: boolean;
	readonly action: "list" | "inspect" | "approve" | "revoke";
	readonly message: string;
	readonly hooks: readonly HookManagementRow[];
	readonly hook?: HookManagementRow;
	readonly issues: readonly string[];
	readonly removed?: boolean;
}

export interface HookManagementServiceOptions extends DiscoverHookConfigOptions {
	readonly allowlistStore?: HookAllowlistStore;
}

export class HookManagementService {
	readonly #options: HookManagementServiceOptions;
	readonly #allowlist: HookAllowlistStore;

	constructor(options: HookManagementServiceOptions) {
		this.#options = options;
		this.#allowlist = options.allowlistStore ?? new HookAllowlistStore({ homeDir: options.homeDir });
	}

	async list(): Promise<HookManagementResponse> {
		const state = await this.#load();
		return response({
			ok: true,
			action: "list",
			message: `configured hooks: ${state.rows.length}`,
			hooks: state.rows,
			issues: state.issues,
		});
	}

	async inspect(identity: string): Promise<HookManagementResponse> {
		const state = await this.#load();
		const hook = state.rows.find((row) => row.identity === identity && validIdentity(identity));
		return response({
			ok: hook !== undefined,
			action: "inspect",
			message: hook
				? `configured hook: ${hook.identity}`
				: `configured hook not found: ${safeIdentity(identity)}`,
			hooks: hook ? [hook] : [],
			...(hook ? { hook } : {}),
			issues: state.issues,
		});
	}

	async approve(identity: string): Promise<HookManagementResponse> {
		return this.#mutate("approve", identity);
	}

	async revoke(identity: string): Promise<HookManagementResponse> {
		return this.#mutate("revoke", identity);
	}

	async #mutate(
		action: "approve" | "revoke",
		identity: string,
	): Promise<HookManagementResponse> {
		const discovery = await this.#discover();
		const spec = discovery.hooks.find((hook) => (
			validIdentity(identity) && hookIdentity(hook) === identity
		));
		const initialIssues = await this.#issues(discovery.diagnostics);
		if (!spec) {
			return response({
				ok: false,
				action,
				message: `configured hook not found: ${safeIdentity(identity)}`,
				hooks: [],
				issues: initialIssues,
			});
		}
		let removed: boolean | undefined;
		try {
			if (action === "approve") await this.#allowlist.approve(spec);
			else removed = await this.#allowlist.revoke(spec);
		} catch {
			return response({
				ok: false,
				action,
				message: "configured hook allowlist update failed",
				hooks: [],
				issues: await this.#issues(discovery.diagnostics),
			});
		}
		const hook = await managementRow(spec, this.#allowlist);
		return response({
			ok: true,
			action,
			message: action === "approve"
				? `approved ${hook.identity}`
				: removed
					? `revoked ${hook.identity}`
					: `not approved ${hook.identity}`,
			hooks: [hook],
			hook,
			issues: await this.#issues(discovery.diagnostics),
			...(removed === undefined ? {} : { removed }),
		});
	}

	async #load(): Promise<{
		readonly rows: readonly HookManagementRow[];
		readonly issues: readonly string[];
	}> {
		const discovery = await this.#discover();
		const rows = await Promise.all(discovery.hooks.map((hook) => (
			managementRow(hook, this.#allowlist)
		)));
		return Object.freeze({
			rows: Object.freeze(rows),
			issues: await this.#issues(discovery.diagnostics),
		});
	}

	#discover() {
		return discoverHookConfig({
			workspaceRoot: this.#options.workspaceRoot,
			homeDir: this.#options.homeDir,
			...(this.#options.includeRepository === undefined
				? {}
				: { includeRepository: this.#options.includeRepository }),
			...(this.#options.platform ? { platform: this.#options.platform } : {}),
			...(this.#options.env ? { env: this.#options.env } : {}),
			...(this.#options.shellPath ? { shellPath: this.#options.shellPath } : {}),
		});
	}

	async #issues(configDiagnostics: readonly HookConfigDiagnostic[]): Promise<readonly string[]> {
		const configIssues = configDiagnostics.map((item) => (
			`${item.scope}:${item.fileLabel}:${item.hookId}:${item.errorClass}`
		));
		const allowlist = await this.#allowlist.load();
		return Object.freeze([
			...configIssues,
			...allowlist.issues.map((issue) => `allowlist:${issue}`),
		]);
	}
}

async function managementRow(
	spec: ConfiguredHookSpec,
	allowlist: Pick<HookAllowlistStore, "statusFor">,
): Promise<HookManagementRow> {
	const approval = await allowlist.statusFor(spec);
	return Object.freeze({
		scope: spec.scope,
		hookId: spec.hookId,
		hookPoint: spec.hookPoint,
		identity: hookIdentity(spec),
		enabled: spec.enabled,
		timeoutMs: spec.timeoutMs,
		workingDirectory: spec.workingDirectory,
		envPolicy: spec.envPolicy,
		...(spec.shellKind ? { shellKind: spec.shellKind } : {}),
		commandDigest: hookCommandDigest(spec.command),
		configPathHash: hookConfigPathHash(spec.configPath),
		allowlistStatus: approval.allowed ? "allowed" : "not_allowed",
		allowlistReason: approval.reason,
	});
}

function response(input: HookManagementResponse): HookManagementResponse {
	return Object.freeze({
		...input,
		hooks: Object.freeze([...input.hooks]),
		issues: Object.freeze([...input.issues]),
	});
}

function validIdentity(value: string): boolean {
	return /^(?:user|repo):[A-Za-z0-9][A-Za-z0-9._-]{0,63}:(?:pre_tool_use|post_tool_use|user_prompt_submit|stop|pre_compact|session_start|session_end)$/u.test(value);
}

function safeIdentity(value: string): string {
	return validIdentity(value) ? value : "hook";
}
