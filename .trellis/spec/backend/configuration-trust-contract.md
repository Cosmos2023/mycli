# Configuration Trust Contract

## 1. Scope / Trigger

This contract applies whenever backend code resolves runtime configuration, selects a launch
profile, reads machine defaults, discovers repository-owned integrations, runs management
diagnostics, or resumes a persisted session.

The trust decision is a prerequisite for reading project-controlled files. An `unknown` or
`untrusted` workspace must not influence model/provider settings, execution rules, hooks, MCP,
plugins, or skills. The gate must be applied before filesystem discovery, not after parsing.

## 2. Signatures

The configuration package exposes these compatibility and metadata entry points:

```ts
export type WorkspaceTrustState = "trusted" | "untrusted" | "unknown";

declare const CONFIG_PROFILE_NAME: unique symbol;
export type ConfigProfileName = string & { readonly [CONFIG_PROFILE_NAME]: true };

export function parseConfigProfileName(value: string): ConfigProfileName;
export function resolveConfigProfilePath(
	homeDir: string,
	profile: ConfigProfileName,
): string;
export function resolveSystemConfigPath(options?: {
	readonly platform?: NodeJS.Platform;
	readonly programDataDir?: string;
}): string;

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
	readonly configProfile?: ConfigProfileName;
	readonly systemConfigPath?: string;
	readonly workspaceTrust?: WorkspaceTrustState;
}

export interface ResolvedConfig {
	readonly config: NodeRuntimeConfig;
	readonly layers: ConfigLayerStack;
	readonly shellSettings: LoadedShellSettings;
	readonly diagnostics: readonly ConfigDiagnostic[];
}

export function resolveShellSettingsState(
	options: ResolveConfigOptions,
): Promise<LoadedShellSettings>;

export const CONFIG_DIAGNOSTIC_VERSION = 1 as const;

export type ConfigDiagnosticCode =
	| "config_read_failed"
	| "config_write_failed"
	| "deprecated_inline_secret"
	| "forbidden_inline_secret"
	| "invalid_toml"
	| "invalid_value"
	| "unknown_key"
	| "unknown_table";

export interface ConfigDiagnostic {
	readonly version: typeof CONFIG_DIAGNOSTIC_VERSION;
	readonly code: ConfigDiagnosticCode;
	readonly severity: "warning" | "error";
	readonly layer?: ConfigLayerId;
	readonly keyPath?: string;
	readonly line?: number;
	readonly column?: number;
	readonly message: string;
	readonly remediation?: string;
}

export class ConfigError extends Error {
	readonly diagnostic: ConfigDiagnostic;
}

export function resolveConfig(
	options: ResolveConfigOptions,
): Promise<NodeRuntimeConfig>;

export function resolveConfigWithMetadata(
	options: ResolveConfigOptions,
): Promise<ResolvedConfig>;

export function resolveConfigWithUserConfigText(
	options: ResolveConfigOptions,
	userConfigText: string,
): Promise<ResolvedConfig>;

export type ConfigManagementCommand =
	| { readonly kind: "config"; readonly action: "validate" | "show"; readonly json: boolean }
	| {
		readonly kind: "config";
		readonly action: "get" | "unset";
		readonly key: string;
		readonly json: boolean;
	}
	| {
		readonly kind: "config";
		readonly action: "set";
		readonly key: string;
		readonly value: string;
		readonly json: boolean;
	};

export interface WritableRuntimeSetting {
	readonly key: string;
	readonly path: readonly string[];
	readonly legacyPaths: readonly (readonly string[])[];
	readonly valueKind: "boolean" | "integer" | "number" | "string";
}

export function mutateUserConfigSetting(
	options: ResolveConfigOptions & {
		readonly action: "set" | "unset";
		readonly key: string;
		readonly value?: string;
	},
): Promise<{ readonly key: string; readonly changed: boolean }>;

// Package-internal: not exported from the @mycli/config root.
type UserConfigEdit =
	| { readonly action: "set"; readonly path: readonly string[]; readonly value: string | number | boolean }
	| { readonly action: "clear"; readonly path: readonly string[]; readonly onlyIfScalar?: boolean };

function applyUserConfigEdits(
	options: ResolveConfigOptions & {
		readonly edits: readonly UserConfigEdit[];
		readonly validateCurrent?: boolean;
		readonly failpoint?: (name: string) => void;
	},
): Promise<boolean>;

export function writeUserProviderConfig(input: UserProviderConfigInput): Promise<string>;
export function saveShellSettings(options: SaveShellSettingsOptions): Promise<ShellSettings>;

export interface ConfigSettingRow {
	readonly key: string;
	readonly value: string | number | boolean | null | Readonly<Record<string, number>>;
	readonly source: ConfigLayerId | "default";
	readonly overridden: readonly ConfigLayerId[];
	readonly truncated?: boolean;
}
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
4. `profile` - `~/.mycli/<name>.config.toml`, only when selected for this launch;
5. `user` - `~/.mycli/config.toml`;
6. `system` - `/etc/mycli/config.toml` on Unix or `%ProgramData%\mycli\config.toml` on Windows;
7. `legacy_user` - `~/.config/mycli/config.toml`;
8. provider and built-in defaults, applied after layer resolution.

`resolveConfig` remains the compatibility facade. New diagnostics and settings surfaces use
`resolveConfigWithMetadata` instead of reconstructing precedence.

### Launch profile and system defaults

`mycli -p <name>` and `mycli --profile <name>` are runtime selectors, not configuration keys or
profile-management commands. Names must match `[A-Za-z0-9_-]+` before any path is constructed. The
path helper repeats that validation at its public JavaScript boundary. Duplicate selectors,
missing values, separators, dots, whitespace, non-ASCII text, and traversal fail before backend or
TUI startup without echoing the submitted value.

The base user file always loads. A selected profile is a sparse layer above it; a missing selected
profile remains present as an enabled empty layer. With no selector, the profile layer is absent.
The selected name is launch-scoped and must not be written to user TOML or `session_preferences`.
New and resumed sessions use the same launch selector, and a supervisor Worker restart must retain
the original canonical `--profile <name>` argument.

The system layer is always present and becomes an enabled empty layer when the file is absent.
Windows uses an absolute `%ProgramData%` value and falls back to `C:\ProgramData`; relative or blank
values cannot redirect the system layer. `systemConfigPath` is an embedder/test seam for
deterministic resolution, not a CLI, model-tool, or management mutation argument. Ordinary mycli
commands never write profile or system files.

### Diagnostic ownership

`backend/packages/config` owns diagnostic classification. Successful metadata resolution returns
warnings through `ResolvedConfig.diagnostics`; fatal read, parse, credential, and known-value
failures throw `ConfigError` through both resolver entry points. Diagnostic surfaces such as doctor
consume the typed shape and must not classify raw TOML, filesystem, or provider-profile exception
text. The compatibility `resolveConfig` facade returns only the effective config on success.

Unknown root keys, unknown tables, and unknown keys inside known tables are warnings. Their values
remain ignored, preserving existing runtime behavior. Known legacy flat runtime keys, root TUI keys,
`[plugins].enabled`, `[plugins].disabled`, and `compaction_l4_trigger_ratios_by_model` are accepted
without false unknown-key warnings.

Syntax diagnostics copy only the numeric `TomlError.line` and `TomlError.column`. Schema findings
use a bounded dotted `keyPath`; the parser does not retain ordinary key ranges. Diagnostic fields
must not include raw values, TOML source/code blocks, exception stacks, request data, credentials,
or absolute paths. Unsupported provider/protocol settings are converted at the settings boundary
to value-free `invalid_value` diagnostics rather than exposing the helper exception message. When
effective-value validation fails after layer composition, the config package maps the canonical
setting key back to `ConfigLayerStack.origins` and adds the stable winning layer id; callers must
not infer ownership by rereading files.

Project, profile, and system credential fields are forbidden. Only a root-level `api_key` in
`user` or `legacy_user` remains runtime-readable and emits `deprecated_inline_secret`; credentials
inside tables, including `model.api_key`, are forbidden in every file layer. Environment
credentials and the credential store remain valid and warning-free.

### Credential readiness

Interactive readiness resolves the complete active session identity, including provider and
`auth_ref`, against the authoritative session workspace and persisted trust state. Its source is
classified in the same precedence used by runtime config: nonblank `MYCLI_API_KEY` is
`environment`, an `auth.json` record for the resolved `auth_ref` is `stored`, a supported user or
legacy-user root `api_key` is `legacy_config`, and absence is `missing`. Project credentials never
participate because they are rejected by the config boundary.

Readiness projection contains only `ready`, bounded provider/auth-reference identities, and the
closed source value. It is provider-free and never serializes the resolved `apiKey`, environment
value, auth-store record, file source, or absolute workspace/home path. Session new/resume and
model changes must re-resolve readiness rather than carrying a boolean from the prior active
session.

### Session snapshot fallback

The config package resolves provider, protocol, model, endpoint identity, credential reference, and
reasoning values for the authoritative session workspace. The app runtime combines those values
with collaboration mode and the selected permission profile in the versioned
`session_preferences` snapshot. Permission selection is not a TOML config fallback and must not be
added to `ResolveConfigOptions` merely to persist a session choice.

An existing valid session snapshot wins over environment, project, profile, user, system, legacy,
and built-in defaults for every field it pins. Current resolved defaults may fill only a missing
legacy snapshot or an optional field absent from that snapshot. Activating a session without
stored preferences must rebuild the complete fallback from current config and the runtime
permission default; it must not reuse values left in memory by the previously active session.
Restoring a snapshot changes active runtime state only and never writes `~/.mycli/config.toml` or
persists the selected profile name.

### Metadata

`ConfigLayerStack.version` and every `ConfigLayerMetadata.version` equal
`CONFIG_LAYER_STACK_VERSION`. The initial version is `1`.

Each layer reports `id`, `scope`, `source`, `enabled`, optional `disabledReason`, and sorted key
names. Each `ConfigOrigin` reports the winning layer and enabled lower-priority layers that were
overridden. Metadata must never include raw values, API keys, tokens, request headers, or provider
payloads.

`ResolvedConfig.shellSettings` is derived from the same ordered `ConfigLayerInput[]` as runtime
values and metadata. Every visual setting reports its stable winning layer or `default` plus
enabled overridden layer ids. Runtime, `/settings`, and configuration projections must not call the
legacy user-only shell loader when canonical layer provenance is required.

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

### Provider-free configuration management

`mycli config validate [--json]`, `show [--json]`, and `get <key> [--json]` are read-only management
commands. `mycli config set <key> <value> [--json]` and `unset <key> [--json]` mutate only
`~/.mycli/config.toml`. Default management composition loads `WorkspaceTrustStore` before
constructing `ConfigManagementService`. Every action runs before TTY validation and never
constructs a model provider, turn runtime, gateway, or TUI.

The CLI profile selector remains runtime-only, matching Codex profile-v2 semantics; it does not
turn `config set` into a profile writer. The system layer still participates in default management
resolution. A `ConfigManagementService` explicitly composed with a validated profile may inspect
that effective stack, but its mutation methods continue to target only the base user file.

All configuration-management responses use `version=1`, their exact action, and bounded config
diagnostics.
`validate` adds no raw configuration fields. Successful `show` adds `workspaceTrust`, credential
status, stable layer rows, and a deterministic allowlist of `ConfigSettingRow` values. Layer rows
contain only `id`, `scope`, `enabled`, and optional `disabledReason`; internal source paths and key
values do not cross the management boundary. Setting origins expose only stable layer ids or
`default`, and overridden origins expose stable ids in precedence order.

The configuration package owns one deterministic setting catalog used by both `show` projection
and mutation lookup. `get` accepts every catalog key, including read-only rows. `set` and `unset`
accept only catalog rows with scalar write metadata; arbitrary paths, structured rows, derived
rows, and credential fields fail before filesystem mutation. Values are parsed according to the
declared type: booleans are exactly `true` or `false`, integers are safe decimal integers, finite
numbers use decimal/exponent syntax, and strings must be nonblank.

Mutation parses the current user document through the lossless TOML patch boundary, writes the
canonical sectioned path, and clears matching legacy aliases. The read/patch/validate/write cycle
runs under the existing per-file lock. Before rename, the complete candidate is validated once as
an isolated user layer and once with every enabled higher layer. Atomic replacement occurs only
when the candidate differs byte-for-byte; an absent unset or repeated set returns `changed=false`.
Comments, newline style, unrelated formatting, unknown keys, and unrelated tables remain owned by
the source document rather than a whole-document serializer.

`applyUserConfigEdits` is the single package-internal persistence kernel for user TOML. It applies
ordered scalar `set` and `clear` edits to one lossless document while holding one per-file lock,
validates the complete final candidate, and performs at most one atomic replacement. It is not
re-exported from `@mycli/config`; model-facing tools and configuration-management commands cannot
submit arbitrary paths. `mutateUserConfigSetting` remains the public allowlisted compiler and asks
the kernel to validate the current document before applying its canonical and legacy-path edits.

`writeUserProviderConfig` and `saveShellSettings` are typed domain compilers over the same kernel.
The provider compiler validates its provider/protocol profile, removes root and `[model]` inline
credentials plus owned flat aliases, normalizes the base URL, and emits one model/request/reasoning
batch. It may repair those owned legacy fields before validation, but the complete final candidate
must still validate, including on a byte-identical no-op. The shell compiler accepts its existing
camelCase and snake_case input aliases, clears their legacy root aliases, and writes the canonical
root TUI compatibility keys in one batch. Both preserve existing bounded domain errors.

Runtime callers pass the active session workspace, environment, selected launch profile, and
persisted trust state into provider and shell persistence so candidate validation uses the same
complete layer stack as the active session. After a visual write, runtime reloads shell settings
from that canonical stack, so a profile may remain the effective source even though the base user
file changed. Provider-free setup uses an untrusted, environment-free validation context rooted at
the user home. Credentials remain in `auth.json`; setup retains separate atomic config/auth writes
and its existing partial-success ordering.

Ordinary `model.select` requests use the closed `session | user` scope contract and default a
missing scope to `session`. Session scope validates the complete catalog selection and credential,
then persists only active-session preferences. User scope calls `writeUserProviderConfig` before
changing session/default state; a failed user write must leave both the prior session preferences
and user TOML unchanged. The setup wizard remains an explicit user-default configuration flow.

Successful mutation responses contain only the canonical key, `changed`, the post-write effective
source, overridden layer ids, and bounded diagnostics. They never contain the submitted value.
Post-write resolution is mandatory because an environment or trusted project layer may continue
to win after the user file is saved.

The resolved config object must never be spread or serialized. The allowlist excludes workspace,
home, session-database, and generated session-id fields. API-key output is only `present` or
`missing`. Strings are control-safe, secret-redacted, and bounded; API base URLs retain only an
HTTP(S) origin/path after removing user info, query, and fragment. The bounded model-ratio map
reports `truncated=true` when more than 64 rows exist. Human and JSON renderers consume the same
sanitized response.

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Trust record is missing, malformed, stale, or unreadable | Resolve trust as `unknown`; disable repository input |
| Workspace cannot be canonicalized | Resolve trust as `unknown`; disable repository input |
| Trust is `unknown` or `untrusted` and project TOML is malformed/unreadable | Do not read it; continue with user/legacy/default layers and emit no project diagnostic |
| Trust is `trusted` and project TOML is malformed | Throw `ConfigError` with `invalid_toml`, `layer=project`, and parser-provided line/column only |
| A config file cannot be read for a non-`ENOENT` reason | Throw `ConfigError` with `config_read_failed` and the file layer, without its absolute path |
| Any config file is missing (`ENOENT`) | Treat that layer as empty |
| No profile is selected | Omit the profile layer and preserve existing behavior |
| A selected profile file is missing | Keep an enabled empty `profile` layer; do not fall back to another profile |
| A profile name is invalid or repeated | Exit `2` before backend/TUI startup; do not echo the value or construct a path |
| Windows ProgramData is blank, relative, or unavailable | Resolve the system path from `C:\ProgramData` |
| A root key, table, or key inside a known table is unsupported | Return a deterministic `unknown_key` or `unknown_table` warning with layer and dotted key path; ignore the value |
| A project, profile, or system config contains an inline credential field | Throw `forbidden_inline_secret` with layer and key path; do not include the value |
| A user or legacy-user config contains root `api_key` | Keep it readable and return `deprecated_inline_secret` with migration remediation |
| Any file config contains a credential field inside a table | Throw `forbidden_inline_secret`; `[model].api_key` is not a compatibility field |
| A known effective value, provider, or protocol is invalid | Throw `invalid_value` with the canonical key path, stable winning layer id when available, and value-free remediation |
| A lower-priority layer supplies the same key | Keep it in `origin.overridden`; do not select its value |
| Metadata is serialized for diagnostics | Expose source and key names only; never expose values or secrets |
| Resumed session workspace differs from launch workspace | Re-resolve trust and configuration using persisted `workspace_root` |
| Valid session snapshot pins a value that differs from current config | Restore the snapshot in memory; do not rewrite user config |
| Legacy snapshot omits `permission_profile` | Use the runtime permission fallback without changing the stored payload |
| Session snapshot is malformed | Fail the transition before publishing target status; do not treat it as missing |
| `config validate` resolves with warnings | Return `ok=true`, keep diagnostics, and exit `0` |
| `config validate` or `show` catches `ConfigError` | Return one typed diagnostic, `ok=false`, and exit `1` without exception text |
| `config` action is missing/unknown, has extra args, or repeats `--json` | Exit `2` before management/backend construction |
| `config show` resolves a credential | Report only `apiKey=present`; never include its value or credential source payload |
| `config get` receives an unknown key | Return value-free `invalid_value`; do not echo the submitted key |
| `config set` or `unset` receives a read-only, structured, credential-like, or unknown key | Return value-free `invalid_value` before creating or replacing the user config |
| A scalar value has invalid syntax or exceeds its numeric type | Return `invalid_value`; omit the submitted value and preserve the original bytes |
| The current document or complete candidate is invalid in isolation or with enabled higher layers | Return the typed config diagnostic and preserve the original bytes |
| A provider write finds an owned legacy root or `[model]` inline credential | Remove it in the lossless batch, validate the credential-free final candidate, and never expose its value |
| A provider or shell batch fails validation, locking, or replacement | Preserve the original bytes and map to the existing bounded domain write error without paths, source, stacks, or values |
| A mutation changes no TOML bytes | Return `changed=false`; do not create a temporary file or replace the target |
| A provider batch changes no bytes and skipped current-document validation for cleanup compatibility | Validate the byte-identical final candidate before returning no-op |
| Lossless patching, locking, or atomic replacement fails unexpectedly | Return `config_write_failed` without an absolute path, source text, stack, or submitted value |
| An unexpected configuration-management exception occurs | Return stable `management_command_failed`; omit stack and raw message |

## 5. Good / Base / Bad Cases

- Good: a trusted project model overrides the user model; an environment model overrides both;
  provenance reports environment as the source and project/user as overridden.
- Good: launch with `--profile work`; trusted project values remain higher priority, user/system
  values remain lower priority, and visual-setting provenance reports the same order.
- Good: resume a session using `--profile work`; config is resolved against the persisted session
  workspace while the launch profile remains active, including after a supervisor Worker restart.
- Good: `model.nmae` produces one `unknown_key` warning naming the owning layer and key path while
  the configured value remains absent from the diagnostic and runtime configuration.
- Good: `config show --json` reports an environment model over project/user models as
  `source=environment, overridden=[project,user]` while omitting layer source paths.
- Good: `config set memory.enabled true` patches only `[memory].enabled`, preserves comments and
  unknown tables, and reports `effectiveSource=environment` when `MYCLI_MEMORY_ENABLED` still wins.
- Good: setting `model.name` over a legacy root `model = "..."` replaces the scalar collision with
  canonical `[model].name` without changing unrelated TOML.
- Good: resume A with `full-access`, resume B with `read-only`, restart on A, and keep both user TOML
  and B's stored snapshot unchanged.
- Good: setup, user-scoped `model.select`, `config set`, and `settings.save` race on one user file;
  each completed batch observes the prior committed bytes under the same lock, so unrelated model,
  memory, and TUI settings all survive.
- Good: provider selection removes legacy inline API keys while preserving CRLF, comments, plugin
  tables, and unknown extension keys inside `[model]` and `[request]`.
- Base: no project trust record exists; user configuration and defaults load normally, and the
  project layer reports `workspace_not_trusted`.
- Base: no profile is selected and no system file exists; public effective values match the prior
  user/legacy/default behavior, with only an enabled empty system metadata row added.
- Base: `--profile draft` selects a file that does not exist yet; the empty profile layer is valid
  and selection is not persisted.
- Base: a fresh home returns defaults and `apiKey=missing` without creating `.mycli`.
- Base: unsetting an absent writable key returns `changed=false`; a repeated set with identical TOML
  does not replace the file.
- Base: a legacy user root `api_key` still resolves but produces one migration warning; the same key
  under `[model]` is rejected.
- Bad: startup parses `.mycli/config.toml`, then checks trust and discards the result. Parsing alone
  crosses the security boundary and can surface project-controlled failures.
- Bad: resume uses `process.cwd()` for trust while loading the session from another workspace. This
  can expose the wrong project's integrations and omit the session project's user decision.
- Bad: resume a legacy session by spreading the previous active session's model or permission into
  the fallback snapshot.
- Bad: doctor catches `Error` and displays its message. Provider/profile helpers may include a raw
  configured value, while TOML errors may include source code and private paths.
- Bad: accept a profile as a raw string in `ResolveConfigOptions`, construct
  `join(homeDir, ".mycli", profile)`, or persist an `active_profile` key. This permits traversal or
  silently changes future launches.
- Bad: load visual settings from only `~/.mycli/config.toml` after runtime selected a profile. The
  TUI would display a different effective value and source than the model runtime.
- Bad: `config show` returns `{...resolved.config}` or serializes `ConfigLayerMetadata.source`,
  exposing credentials, generated ids, or absolute paths.
- Bad: mutation parses with `smol-toml`, stringifies the complete object, and writes after releasing
  the lock. This discards comments and permits a concurrent writer to be overwritten.
- Bad: implement provider or TUI persistence as repeated public `config set` calls. Intermediate
  provider states can become visible and TUI-only aliases would leak into the public catalog.
- Bad: a mutation response includes `value`, a raw parser error, or the target path. Submitted
  values and private paths must not cross the management boundary even on failure.

## 6. Tests Required

- Config unit tests assert exact layer order and the winning/overridden provenance ids.
- Profile unit tests assert the ASCII name grammar, public path-helper revalidation, Unix system
  path, absolute Windows ProgramData path, and `C:\ProgramData` fallback.
- Config unit tests cover selected/missing/unselected profiles, missing system config, full
  `session > environment > project > profile > user > system > legacy_user` precedence, and
  profile/system visual-setting provenance.
- Config unit tests place malformed project TOML in an unknown and untrusted workspace and assert
  resolution succeeds without reading it.
- Config unit tests cover trusted project, user-only, legacy fallback, environment override, CLI
  override, malformed enabled layers, and missing files.
- Config unit tests assert diagnostic version, code, severity, deterministic order, owning file
  layer, dotted key path, and parser-provided line/column where applicable.
- Config tests cover unknown roots/tables/known-table keys, accepted legacy/TUI/plugin vocabulary,
  project/profile/system credential rejection, legacy root `api_key` migration, table credential
  rejection, and unsupported provider/protocol redaction.
- Config tests place sentinels in profile/system unknown keys and invalid effective values, then
  assert stable layer ids while excluding values and absolute home paths from diagnostics.
- Every redaction test places a sentinel in the configured value and asserts it is absent from both
  `ConfigError.message` and the serialized diagnostic.
- Integration adapter tests make repository hook/MCP/plugin files unreadable or malformed and
  assert `includeRepository: false` neither reads nor reports them.
- Backend integration tests assert project configuration becomes active only after trust is
  persisted.
- CLI tests assert split/equal and short/long profile forms canonicalize to `--profile <name>`, and
  invalid or duplicate selectors start neither backend nor TUI.
- Backend integration tests launch and resume the same session with and without a profile and
  assert launch-scoped settings; supervisor tests assert the canonical profile argument survives a
  hard Worker restart.
- Resume integration tests seed a session whose `workspace_root` differs from the launch directory
  and assert trust status and discovered resources belong only to the persisted workspace.
- Session integration tests persist different model/effort/mode/permission snapshots, switch both
  directions, restart, and assert status restores the target snapshot without a user-config write.
- Management and doctor tests assert their repository visibility uses the same trust state as
  runtime composition.
- Doctor tests assert warnings and fatal `ConfigError` values map to one bounded row containing only
  layer, key, line, column, public message, and remediation; doctor must not start a provider.
- Configuration-management parser tests cover all five actions, JSON placement, blank/missing
  keys and values, extra arguments, and duplicate flags.
- Configuration-management tests cover a fresh home, trusted environment/project/user provenance,
  an unread malformed untrusted project file, warning-only unknown keys, fatal TOML/value errors,
  and human/JSON sentinel redaction.
- Config editor tests assert canonical/legacy collision handling, comment and CRLF/LF preservation,
  typed scalar rejection, isolated and higher-layer cross-field validation, no-op identity,
  concurrent lock serialization, private modes, and byte preservation after every failed candidate.
- Provider-writer tests assert owned legacy and inline-secret cleanup, base-URL and reasoning
  normalization, extension-key/comment/CRLF preservation, byte-identical no-op, final-candidate
  rejection, private modes, and failure redaction.
- Shell-settings tests assert camelCase/snake_case input compatibility, canonical alias cleanup,
  comment/CRLF preservation, byte-identical no-op, and exact-byte preservation after validation or
  pre-rename failure.
- One concurrency test runs provider, catalog-backed CLI, and shell-settings mutations against the
  same home and asserts every independently owned path survives.
- Every mutation redaction test places a submitted sentinel in the value or unknown key and asserts
  it is absent from human output, JSON output, serialized diagnostics, and exception messages.
- CLI tests run `config show/get/set/unset --json` under non-TTY streams and assert zero
  backend/provider/TUI starts.

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

### Profile selection

Wrong:

```ts
const profilePath = join(homeDir, ".mycli", `${argv.profile}.config.toml`);
session.preferences.activeProfile = argv.profile;
```

Correct:

```ts
const configProfile = parseConfigProfileName(rawProfile);
const config = await resolveConfig({
	homeDir,
	workspaceRoot: authoritativeWorkspaceRoot,
	env,
	workspaceTrust,
	configProfile,
});
```

Validation precedes path construction, and only the typed launch selector enters the resolver. The
selector is passed again after resume workspace resolution and Worker restart but is never written
to TOML or session state.

### Diagnostic projection

Wrong:

```ts
try {
	await resolveConfig(options);
} catch (error) {
	return { status: "failed", message: String(error) };
}
```

Correct:

```ts
try {
	const resolved = await resolveConfigWithMetadata(options);
	return resolved.diagnostics.map(projectDiagnosticRow);
} catch (error) {
	return isConfigError(error)
		? [projectDiagnosticRow(error.diagnostic)]
		: [{ status: "failed", message: "configuration invalid" }];
}
```

`projectDiagnosticRow` may project only the bounded typed fields; it must not inspect raw parser or
filesystem exceptions.

### Effective configuration projection

Wrong:

```ts
return { ok: true, action: "show", settings: resolved.config, layers: resolved.layers };
```

Correct:

```ts
return {
	ok: true,
	action: "show",
	credentials: { apiKey: resolved.config.apiKey ? "present" : "missing" },
	layers: resolved.layers.layers.map(projectStableLayer),
	settings: runtimeSettingSnapshots(resolved.config)
		.map((snapshot) => projectSetting(snapshot, resolved.layers)),
};
```

### User configuration mutation

Wrong:

```ts
const parsed = parse(await readFile(userPath, "utf8"));
setPath(parsed, key.split("."), rawValue);
await writeFile(userPath, stringify(parsed));
return { ok: true, key, value: rawValue };
```

Correct:

```ts
const mutation = await mutateUserConfigSetting({
	...resolveOptions,
	action: "set",
	key,
	value: rawValue,
});
const resolved = await resolveConfigWithMetadata(resolveOptions);
const setting = projectSettingByKey(mutation.key, resolved);
return {
	ok: true,
	action: "set",
	key: mutation.key,
	changed: mutation.changed,
	effectiveSource: setting.source,
	overridden: setting.overridden,
};
```

The editor owns type parsing, lossless path edits, lock scope, candidate validation, atomicity, and
value-free diagnostics. The management layer owns only post-write effective projection.

### Typed grouped user-config persistence

Wrong:

```ts
for (const [key, value] of Object.entries(modelSettings)) {
	await mutateUserConfigSetting({ ...resolveOptions, action: "set", key, value: String(value) });
}
```

Correct:

```ts
await writeUserProviderConfig({
	...validatedProviderSelection,
	homeDir,
	workspaceRoot: active.workspaceRoot,
	env,
	workspaceTrust: await trustStore.load(active.workspaceRoot),
});
```

Domain writers compile a complete ordered batch internally. Callers never construct arbitrary
paths, and a grouped provider or TUI update has one lock scope, one final validation, and at most one
rename.

## Scenario: Single Visual Setting Persistence And Provenance

### 1. Scope / Trigger

- Trigger: changing the TUI settings catalog, `settings.save`, shell-setting descriptors, or the
  lossless user-config writer.
- A user-default visual change owns one descriptor. It must not materialize unrelated defaults in
  the user file or report those defaults as user-owned.

### 2. Signatures

```ts
export interface SaveShellSettingOptions extends LoadShellSettingsOptions {
	readonly key: string;
	readonly value: string | boolean;
	readonly workspaceRoot?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly workspaceTrust?: WorkspaceTrustState;
	readonly configProfile?: ConfigProfileName;
	readonly systemConfigPath?: string;
}

export interface LoadedShellSettings {
	readonly settings: ShellSettings;
	readonly sources: Readonly<Record<ShellSettingName, ConfigLayerId | "default">>;
	readonly overridden: Readonly<Record<ShellSettingName, readonly ConfigLayerId[]>>;
}

export function saveShellSetting(
	options: SaveShellSettingOptions,
): Promise<LoadedShellSettings>;
```

### 3. Contracts

- `key` is an exact stable id from `SHELL_SETTING_DESCRIPTORS`, such as `tui.theme`; it is not an
  arbitrary TOML path or a general runtime setting id.
- The config package validates the typed value against the owning descriptor, clears only that
  descriptor's legacy aliases, writes only its canonical path, and performs one validated atomic
  replacement under the shared user-config lock.
- `tui.statusbar_mode` additionally maintains the existing `statusline_enabled` compatibility key;
  changing another descriptor leaves that key untouched.
- After the write, runtime reloads the complete canonical shell snapshot. `sources` and
  `overridden` derive from the ordered active layers, not from values submitted by the caller.
- `saveShellSettings` remains the compatibility grouped writer. New interactive single-row changes
  use `saveShellSetting` so defaults not owned by the change remain absent.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Unknown or non-TUI `key` | Reject with bounded `shell_settings_invalid`; do not create or replace config |
| Value is outside descriptor values or has the wrong scalar type | Reject before persistence; do not echo the value |
| Current config, candidate validation, locking, or rename fails | Preserve prior bytes and return bounded `shell_settings_write_failed` |
| Selected value already matches canonical user config | Return the authoritative snapshot without replacing the file |
| A profile or trusted project still owns the setting after a user write | Return that winning source and the user layer as overridden |
| Another visual setting is still a built-in default | Return its source as `default` and leave its path absent |

### 5. Good / Base / Bad Cases

- Good: save `tui.theme=light`; only `tui_theme` is added, `sources.theme=user`, and all other fresh
  settings remain `default`.
- Good: save `tui.theme=dark` while a selected profile says `light`; write only the base user file,
  then return `light`, `sources.theme=profile`, and `overridden.theme=[user,...]`.
- Base: a legacy alias owns the selected setting; saving migrates only that setting to its canonical
  path while preserving unrelated comments, tables, and newline style.
- Bad: receive a full effective settings object from the TUI and rewrite all nine descriptors,
  converting every built-in default into an apparent user preference.

### 6. Tests Required

- Config unit tests persist one descriptor and assert exact TOML, selected source `user`, and every
  untouched descriptor source `default`.
- Layered shell tests assert project/profile/user/system winners and overridden ids use the same
  order as runtime configuration.
- Gateway/backend integration tests save one stable id, reload the snapshot, and assert untouched
  sources do not change.
- Existing grouped-writer tests retain comment, CRLF, validation, no-op, redaction, and concurrency
  coverage.

### 7. Wrong vs Correct

#### Wrong

```ts
await saveShellSettings({ homeDir, settings: completeEffectiveSettings });
return { settings: completeEffectiveSettings, sources: allUserSources };
```

#### Correct

```ts
const loaded = await saveShellSetting({
	homeDir,
	key: "tui.theme",
	value: "light",
});
return { settings: loaded.settings, sources: loaded.sources };
```
