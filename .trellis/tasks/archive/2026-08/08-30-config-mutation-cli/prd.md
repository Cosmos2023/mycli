# Safe Configuration Mutation CLI

## Goal

Let users inspect and safely change supported user-level settings without manually editing TOML,
while preserving comments, formatting, unrelated keys, atomicity, validation, and the existing
secret/trust boundaries.

## Requirements

- Add provider-free `mycli config get <key> [--json]`,
  `mycli config set <key> <value> [--json]`, and
  `mycli config unset <key> [--json]` management commands.
- Reuse the canonical setting registry used by `config show`; unknown, derived, structured, and
  credential-like keys must be rejected before any file write.
- The MVP writes only `~/.mycli/config.toml`. It must not modify project or legacy-user files.
- Parse CLI values according to each setting's declared type. Boolean and numeric values must not
  silently coerce invalid text; string values remain one shell argument.
- Persist canonical sectioned TOML keys and remove the matching legacy flat alias when setting or
  unsetting a value so one user document cannot retain a conflicting fallback.
- Preserve comments, whitespace style, unknown tables/keys, and unrelated values. Do not implement
  mutation by parsing and serializing the complete file through `smol-toml`.
- Perform each mutation under the existing per-file lock and atomic replacement boundary. Validate
  the complete candidate configuration, including cross-field constraints and enabled higher
  layers, before rename.
- `get` returns the same sanitized effective value, winning source, and overridden layers as
  `config show`; it never returns credentials or internal paths.
- Mutation responses never echo the submitted raw value. They report the canonical key, whether
  the user document changed, and the post-write effective source so users can see when an
  environment or trusted project layer still overrides their setting.
- Human and JSON output must derive from the same closed response types. Errors remain bounded and
  must not include raw TOML, submitted values, absolute paths, environment contents, or stacks.
- Existing setup, shell settings, configuration resolution, and management commands remain
  backward compatible.

## Acceptance Criteria

- [ ] Parser tests cover `get`, `set`, and `unset`, JSON placement, missing arguments, extra
  arguments, duplicate flags, blank keys, and invalid values.
- [ ] CLI tests prove all three actions run before TTY/backend/provider/TUI startup.
- [ ] A `set` on a fresh home creates a private canonical user config and `get` reports the new
  effective value.
- [ ] Setting and unsetting preserve comments, CRLF/LF style, unrelated tables, unknown keys, and
  inline formatting covered by the selected lossless TOML editor.
- [ ] Setting a canonical path removes its matching legacy flat alias; unsetting removes both.
- [ ] Invalid keys, derived keys, structured keys, credential-like keys, invalid typed values, and
  invalid cross-field candidates fail before replacement and leave the original bytes unchanged.
- [ ] A concurrent writer is serialized by the existing lock and cannot be silently overwritten by
  a stale read/modify/write cycle.
- [ ] Repeating the same set or unsetting an absent key is an idempotent no-op response.
- [ ] Post-write responses identify an environment/project override without exposing its value.
- [ ] Sentinel secrets, submitted values, raw TOML, and absolute paths are absent from both human
  and JSON failures.
- [ ] Help and README configuration guidance document the new commands and user-only scope.

## Definition Of Done

- Focused config/package/app tests and the full repository test suite pass.
- Build, lint, typecheck, contract drift, release verification, and `git diff --check` pass.
- The configuration code-spec records mutation signatures, validation, atomicity, and redaction.
- Work is committed in focused batches, the task is archived, and the session is journaled without
  including unrelated Windows sandbox changes.

## Technical Approach

Introduce a typed configuration setting catalog shared by read projection and mutation. Each
writable entry owns its canonical dotted path, legacy aliases, value kind, and conversion to a TOML
value. Derived and structured read-only rows remain visible but cannot be mutated.

Add a user-config edit service inside `@mycli/config`. It applies set/clear edits to the current
document through a small lossless TOML patch dependency, then validates the candidate through the
same resolver used at runtime. Extend the existing private atomic updater so an asynchronous
candidate builder can run while the lock is held and can signal a no-op; rename only after the
candidate is valid. The app management service performs the mutation and resolves the sanitized
post-write row for output.

## Decision (ADR-lite)

**Context**: The existing setup and shell-settings writers parse and stringify complete TOML, which
can discard comments and formatting. Codex instead uses discrete `SetPath`/`ClearPath` edits on a
lossless TOML document and atomically persists the result.

**Decision**: Build a user-only, allowlisted path mutation boundary using a dependency-free,
format-preserving TOML patch library plus the existing lock/atomic writer. Validate the full
candidate before replacement and report effective precedence after replacement.

**Consequences**: Users get safe scriptable configuration without comment loss. The setting catalog
becomes the single source for read/write capabilities. Project edits, credentials, complex map
values, batch transactions, and an interactive editor remain separate future slices.

## Expansion Sweep

- Future evolution: the edit engine can support validated batches and TUI settings without changing
  the atomic persistence boundary.
- Related scenarios: setup and `/settings` can migrate to the same edit engine after its behavior is
  proven, eliminating whole-document rewrites.
- Failure cases: invalid current TOML, stale concurrent writes, no-op edits, higher-layer overrides,
  legacy aliases, secrets, and cross-field constraints are covered in this MVP.

## Out Of Scope

- Project/legacy/system configuration mutation or trust prompts for writes.
- API keys, auth-store mutation, secret migration, or printing secret values.
- Interactive `config edit`, a TUI settings redesign, or live mutation of a running session.
- Arbitrary TOML paths, arrays, tables, model-ratio maps, plugin/MCP/hook configuration, or batch
  imports.
- Rewriting existing setup and shell-settings writers in this slice.
- Unrelated Windows sandbox implementation and CI changes.

## Technical Notes

- Existing read boundary: `backend/apps/mycli/src/management/config.ts`.
- Existing atomic boundary: `backend/packages/config/src/private-file-writer.ts`.
- Existing whole-document writers: `user-config-writer.ts` and `shell-settings.ts`.
- Applicable specs: `.trellis/spec/backend/configuration-trust-contract.md`,
  `.trellis/spec/backend/runtime-tui-gateway-contract.md`, and
  `.trellis/spec/backend/quality-guidelines.md`.
- Research: [`research/config-mutation-boundary.md`](research/config-mutation-boundary.md).

