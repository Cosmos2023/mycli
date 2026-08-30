# Configuration Command Boundary Research

## Existing mycli foundation

- Management commands are parsed before TTY checks and before backend, provider, gateway, or TUI
  construction. The new command should use the same boundary.
- `resolveConfigWithMetadata` already returns the resolved runtime config, a deterministic layer
  stack, per-key winning and overridden origins, and bounded typed diagnostics.
- Project configuration is read only when the persisted workspace trust state is `trusted`.
- Layer metadata contains absolute source paths for internal use. Those paths are not suitable for
  management output; stable layer ids are sufficient for users and automation.
- The resolved runtime config contains API credentials and process-specific paths/session ids.
  Serializing it directly would cross the repository's redaction boundary.

## Comparable command patterns

- mycli's `doctor --json` uses one sanitized response as the source for both JSON and human output,
  remains provider-free, and uses warning-only success semantics.
- mycli's hooks/plugins/MCP commands use closed command unions, stable action names, and reject
  invalid arguments before runtime composition.
- Local Codex source emphasizes setup, authentication, and workspace trust as explicit control-plane
  states. Initial source inspection did not identify a directly equivalent full `config get/set`
  command, so this is a mycli-native workflow rather than claimed command parity.

## Feasible scopes

### A. Validate only

Add `mycli config validate [--json]`. This is the smallest slice and exposes existing typed
diagnostics, but users still cannot explain which layer won or why a setting is effective.

### B. Validate and show (recommended)

Add `validate` plus `show`. `show` uses an explicit allowlist to project effective non-secret
settings, stable layer ids, and overridden layer ids. Credential values become `present` or
`missing`; filesystem paths, raw TOML, environment values, and API keys are never included.

This completes a useful preflight workflow without introducing configuration writes.

### C. Validate, show, and set

Also add a mutating editor. This immediately requires scope selection (user/project), workspace
trust and approval policy, TOML comment preservation, atomic writes, concurrent update behavior,
and credential routing. It is too broad for this slice.

## Recommended response boundary

- Both actions load persisted workspace trust and call the canonical resolver exactly once.
- Warnings are returned in deterministic order and do not make validation fail.
- Fatal `ConfigError` values become one bounded diagnostic and exit `1`.
- Unexpected failures become one stable generic issue without exception text or stack data.
- `show` projects only stable runtime settings. It excludes workspace/home/database paths and
  generated session ids.
- Origins expose only `session`, `environment`, `project`, `user`, `legacy_user`, or `default`.
  The internal metadata `source` field and absolute paths never cross the command boundary.
- API credential output is status-only. Other user-visible values are explicitly selected and
  scalar/structured values are bounded.
- Human and JSON output consume the same sanitized response object.

## Expansion sweep

- Future evolution: the projection can later support `--origin <layer>` or a settings editor without
  changing the resolver or the initial response version.
- Related flows: setup and doctor should continue using the same trust decision and diagnostic
  vocabulary; this slice should not duplicate their writes or health checks.
- Edge cases: untrusted project config remains unread and appears as a disabled layer; malformed
  enabled TOML fails safely; unknown keys remain warnings; missing config files are a valid default
  configuration.

## Relevant contracts and code

- `.trellis/spec/backend/configuration-trust-contract.md`
- `.trellis/spec/backend/runtime-tui-gateway-contract.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `backend/packages/config/src/settings.ts`
- `backend/packages/config/src/config-layers.ts`
- `backend/apps/mycli/src/management/`
