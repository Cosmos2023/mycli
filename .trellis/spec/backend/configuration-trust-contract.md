# Configuration Trust Contract

## 1. Scope / Trigger

This contract applies whenever backend code resolves runtime configuration, discovers
repository-owned integrations, runs management diagnostics, or resumes a persisted session.

The trust decision is a prerequisite for reading project-controlled files. An `unknown` or
`untrusted` workspace must not influence model/provider settings, execution rules, hooks, MCP,
plugins, or skills. The gate must be applied before filesystem discovery, not after parsing.

## 2. Signatures

The configuration package exposes these compatibility and metadata entry points:

```ts
export type WorkspaceTrustState = "trusted" | "untrusted" | "unknown";

export interface ResolveConfigOptions {
	readonly homeDir: string;
	readonly workspaceRoot: string;
	readonly env: NodeJS.ProcessEnv;
	readonly overrides?: {
		readonly provider?: ProviderId;
		readonly protocol?: ProtocolId;
		readonly model?: string;
		readonly apiBaseUrl?: string;
		readonly authRef?: string;
		readonly reasoningEffort?: ReasoningEffort;
		readonly thinkingEnabled?: boolean;
		readonly session?: string;
	};
	readonly workspaceTrust?: WorkspaceTrustState;
}

export interface ResolvedConfig {
	readonly config: NodeRuntimeConfig;
	readonly layers: ConfigLayerStack;
}

export function resolveConfig(
	options: ResolveConfigOptions,
): Promise<NodeRuntimeConfig>;

export function resolveConfigWithMetadata(
	options: ResolveConfigOptions,
): Promise<ResolvedConfig>;
```

Repository integration adapters accept an `includeRepository?: boolean` option. Runtime and
default management composition must pass `includeRepository: workspaceTrust === "trusted"`.
`WorkspaceTrustStore.load(workspaceRoot)` is the canonical trust lookup.

## 3. Contracts

### Layer order

Layers are passed to the pure resolver in descending precedence:

1. `session` - CLI and active-session overrides;
2. `environment` - `MYCLI_*` process variables;
3. `project` - `<workspace>/.mycli/config.toml`, only when trusted;
4. `user` - `~/.mycli/config.toml`;
5. `legacy_user` - `~/.config/mycli/config.toml`;
6. provider and built-in defaults, applied after layer resolution.

`resolveConfig` remains the compatibility facade. New diagnostics and settings surfaces use
`resolveConfigWithMetadata` instead of reconstructing precedence.

### Metadata

`ConfigLayerStack.version` and every `ConfigLayerMetadata.version` equal
`CONFIG_LAYER_STACK_VERSION`. The initial version is `1`.

Each layer reports `id`, `scope`, `source`, `enabled`, optional `disabledReason`, and sorted key
names. Each `ConfigOrigin` reports the winning layer and enabled lower-priority layers that were
overridden. Metadata must never include raw values, API keys, tokens, request headers, or provider
payloads.

### Trust gate

When `workspaceTrust` is `unknown` or `untrusted`:

- the project layer remains in the stack with `enabled: false`;
- its `disabledReason` is exactly `workspace_not_trusted`;
- its `keys` array is empty;
- project TOML is not opened or parsed;
- repository hooks, MCP, plugins, skills, and project execution rules are not discovered.

Omitting `workspaceTrust` retains legacy library behavior and may load project configuration.
Interactive runtime and default management callers must not omit it.

### Resume ownership

For a new session, trust is resolved from the launch workspace. For a resumed session, after the
session record is loaded, the authoritative workspace is `sessions.workspace_root`. Runtime must
reload trust and resolve configuration/integrations against that persisted workspace before
continuing startup. The launch directory must not admit repository configuration or integrations
for the resumed session.

Repository integrations are startup-scoped. Granting trust during a running session requires a
restart before repository hooks, MCP, plugins, and skills become visible.

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Trust record is missing, malformed, stale, or unreadable | Resolve trust as `unknown`; disable repository input |
| Workspace cannot be canonicalized | Resolve trust as `unknown`; disable repository input |
| Trust is `unknown` or `untrusted` and project TOML is malformed/unreadable | Do not read it; continue with user/legacy/default layers |
| Trust is `trusted` and project TOML is malformed | Throw `config_error: invalid TOML in project config` |
| Trust is `trusted` and project TOML cannot be read for a non-`ENOENT` reason | Throw `config_error: could not read project config` |
| Any config file is missing (`ENOENT`) | Treat that layer as empty |
| A lower-priority layer supplies the same key | Keep it in `origin.overridden`; do not select its value |
| Metadata is serialized for diagnostics | Expose source and key names only; never expose values or secrets |
| Resumed session workspace differs from launch workspace | Re-resolve trust and configuration using persisted `workspace_root` |

## 5. Good / Base / Bad Cases

- Good: a trusted project model overrides the user model; an environment model overrides both;
  provenance reports environment as the source and project/user as overridden.
- Base: no project trust record exists; user configuration and defaults load normally, and the
  project layer reports `workspace_not_trusted`.
- Bad: startup parses `.mycli/config.toml`, then checks trust and discards the result. Parsing alone
  crosses the security boundary and can surface project-controlled failures.
- Bad: resume uses `process.cwd()` for trust while loading the session from another workspace. This
  can expose the wrong project's integrations and omit the session project's user decision.

## 6. Tests Required

- Config unit tests assert exact layer order and the winning/overridden provenance ids.
- Config unit tests place malformed project TOML in an unknown and untrusted workspace and assert
  resolution succeeds without reading it.
- Config unit tests cover trusted project, user-only, legacy fallback, environment override, CLI
  override, malformed enabled layers, and missing files.
- Integration adapter tests make repository hook/MCP/plugin files unreadable or malformed and
  assert `includeRepository: false` neither reads nor reports them.
- Backend integration tests assert project configuration becomes active only after trust is
  persisted.
- Resume integration tests seed a session whose `workspace_root` differs from the launch directory
  and assert trust status and discovered resources belong only to the persisted workspace.
- Management and doctor tests assert their repository visibility uses the same trust state as
  runtime composition.

## 7. Wrong vs Correct

### Wrong

```ts
const config = await resolveConfig({ homeDir, workspaceRoot, env });
const trust = await trustStore.load(workspaceRoot);
const integrations = await discoverIntegrations({ workspaceRoot });
```

This reads project configuration before trust and discovers repository integrations regardless of
the decision.

### Correct

```ts
const trust = await trustStore.load(workspaceRoot);
const config = await resolveConfig({
	homeDir,
	workspaceRoot,
	env,
	workspaceTrust: trust,
});
const integrations = await discoverIntegrations({
	workspaceRoot,
	includeRepository: trust === "trusted",
});
```

On resume, assign `workspaceRoot` from the stored session before repeating this sequence.
