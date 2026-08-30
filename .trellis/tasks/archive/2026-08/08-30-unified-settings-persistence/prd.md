# Unified Setup And TUI Settings Persistence

## Goal

Make setup and interactive settings changes use the same lossless, validated, atomic user-config
mutation boundary as `mycli config set/unset`, so routine UX no longer rewrites the complete TOML
document or drifts from the canonical setting catalog.

## What I Already Know

- `mutateUserConfigSetting` now owns typed scalar parsing, canonical/legacy path cleanup, lossless
  TOML patching, lock-scoped candidate validation, atomic replacement, and no-op detection.
- Existing setup and shell-settings writers predate that boundary and use whole-document
  `smol-toml` parse/stringify flows that can discard comments and formatting.
- The TUI already exposes `/settings`, and setup persists both provider configuration and
  credentials without printing secrets.
- Configuration mutations remain user-only; project configuration, arbitrary paths, and credential
  values do not belong in the generic setting catalog.

## Requirements

- Add one package-internal batch edit boundary with ordered scalar `set` and `clear` operations.
  It must parse and patch once under one per-file lock, validate the complete candidate, and perform
  at most one atomic replacement.
- Keep the internal batch path API unavailable to model-facing/config-management callers. Public
  `config set/unset` continues to resolve keys through the scalar allowlist and compiles one
  operation into the shared engine.
- Migrate `writeUserProviderConfig`, covering setup and the TUI model selector, to one typed batch.
  Preserve provider-profile validation, base-URL normalization, legacy flat-key cleanup, inline
  credential removal, request-cache fields, and reasoning enable/effort behavior.
- Migrate `saveShellSettings`, covering `/settings`, to one typed batch. Preserve its accepted
  camelCase/snake_case inputs, canonical root compatibility keys, defaults, and returned normalized
  `ShellSettings` object.
- Preserve comments, unknown keys/tables, newline style, private file modes, and atomicity.
- Keep secrets out of config mutation requests, responses, errors, logs, and TUI state.
- Keep provider-free behavior testable without a live model API.
- Preserve existing setup cancellation/fallback, model selection, `/settings` rendering, and
  command/gateway contracts. This is a persistence migration, not a visual redesign.
- Keep config and credential-store writes as separately atomic files and preserve setup's existing
  ordering and partial-success semantics.

## Acceptance Criteria

- [x] Provider writes change only intended provider/model/auth-reference/request/reasoning paths,
      remove deprecated inline credentials and aliases, and preserve unrelated comments and TOML.
- [x] `/settings` changes only intended visual keys and preserves unrelated comments and TOML.
- [x] Both writers preserve LF/CRLF style and return no-op without replacing an identical document.
- [x] Failed validation or persistence leaves the previous user document unchanged.
- [x] Setup cancellation creates no configuration or credential changes.
- [x] Human/TUI failures remain bounded and do not expose submitted secrets or absolute paths.
- [x] Concurrent provider, CLI, or TUI mutations serialize without silently losing a completed
      update from another caller.
- [x] `config set/unset` behavior remains unchanged after it is refactored onto the batch engine.
- [x] Existing setup, config-management, and TUI settings tests remain green.

## Definition Of Done

- Focused config, app, and TUI tests cover the migrated persistence paths.
- Lint, typecheck, build, contracts, release verification, and the full repository test suite pass.
- Configuration and runtime-TUI code-specs describe ownership and failure behavior.
- Work is committed and archived without including the unrelated Windows sandbox changes.

## Out Of Scope

- Project or legacy-user configuration writes.
- Generic credential mutation through `config set` or `/settings`.
- A complete settings information architecture or visual redesign unless required for correctness.
- A public arbitrary-path edit API, a batch `config set` command, or project-scope edits.
- Batch transactions across the config file and credential store; setup must retain its documented
  partial-success semantics where credentials and config cannot be one filesystem transaction.

## Technical Approach

Extract the existing lossless read/patch/validate/write body into a package-internal batch editor.
Each domain wrapper validates and normalizes its own typed input, then emits ordered `set`/`clear`
operations. The editor applies the complete operation list to `@decimalturn/toml-patch`'s mutable
document representation while holding `atomicPrivateFileUpdate`'s lock, validates the final user
candidate through the canonical resolver, and returns a no-op when serialized bytes are unchanged.

Provider and shell wrappers must remain the only owners of their compatibility aliases. The shared
editor knows path mechanics and atomicity, but not provider profiles, TUI enums, model-facing
allowlists, or credentials.

## Decision (ADR-lite)

**Context**: Reusing the public single-setting API sequentially would expose partial provider
groups and would require adding private TUI compatibility keys to the public catalog. Maintaining
two special whole-document writers would continue comment loss and duplication.

**Decision**: Follow Codex's `ConfigEditsBuilder` ownership model with an internal ordered batch
engine and typed domain wrappers. Migrate both remaining user-facing writers in one slice because
they share the same target file and failure mode.

**Consequences**: Setup, model selection, `/settings`, and `config set/unset` share one lock and
lossless persistence kernel. The config/auth cross-file boundary remains non-transactional, and a
future public batch command still requires its own allowlist and response design.

## Research References

- [`research/codex-settings-persistence.md`](research/codex-settings-persistence.md) compares the
  existing writers with Codex `ConfigEditsBuilder` and records the selected migration.

## Technical Notes

- New mutation boundary: `backend/packages/config/src/user-config-editor.ts`.
- Existing setup writer: `backend/packages/config/src/user-config-writer.ts`.
- Existing shell settings writer: `backend/packages/config/src/shell-settings.ts`.
- App setup composition: `backend/apps/mycli/src/setup.ts` and setup management paths.
- TUI settings surface: `tui/mycli-shell` settings selector and gateway callbacks.
- Applicable specs: `.trellis/spec/backend/configuration-trust-contract.md` and
  `.trellis/spec/backend/runtime-tui-gateway-contract.md`.
