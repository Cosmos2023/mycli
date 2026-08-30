# Codex And mycli Settings Persistence Research

## Current mycli paths

- `mutateUserConfigSetting` already patches one allowlisted scalar path losslessly under the
  per-file lock and validates the candidate before atomic replacement.
- `writeUserProviderConfig` still parses and serializes the complete document with `smol-toml`.
  Setup writes model/request fields together, removes inline credentials, then writes the auth
  store separately.
- `saveShellSettings` also parses and serializes the complete document. The TUI sends one validated
  visual-settings object through the gateway, and the backend persists root-level compatibility
  keys such as `tui_theme` and `tui_statusbar_mode`.
- Calling the public single-setting mutation API repeatedly would acquire multiple locks, validate
  intermediate documents, and expose partially applied provider groups if a later step failed.

## Codex pattern

- `codex-rs/core/src/config/edit.rs` defines host-owned `ConfigEdit::SetPath` and
  `ConfigEdit::ClearPath` plus typed domain-specific variants.
- `ConfigEditsBuilder` collects a vector of edits, parses one `toml_edit::DocumentMut`, applies all
  edits in order, skips a no-op document, and performs one atomic write.
- TUI helpers construct typed edits such as `syntax_theme_edit`; the interactive layer does not
  own arbitrary TOML paths.
- After persistence, Codex can rebuild/read effective configuration when higher-precedence layers
  may override the saved user value.

## Feasible approaches

### A. Internal lossless batch engine, migrate both writers (recommended)

Extract a package-internal `SetPath/ClearPath` batch boundary from `user-config-editor.ts`.
`mutateUserConfigSetting`, provider setup, and shell settings each compile their typed input to one
ordered edit batch. Validate the final candidate once and atomically replace once.

Pros: matches Codex ownership, preserves public allowlists, prevents intermediate provider states,
and removes both remaining whole-document writers. Cons: requires careful legacy-key ordering and
tests for three callers.

### B. Reuse the public single-setting API sequentially

Translate setup fields into repeated `mutateUserConfigSetting` calls and add TUI keys to the public
catalog.

Pros: minimal new code. Cons: partial batches, repeated locking/validation, wider public mutation
surface, and a poor fit for TUI-only compatibility keys.

### C. Migrate setup only

Add a provider-specific lossless writer while leaving shell settings unchanged.

Pros: smaller immediate diff. Cons: duplicates the batch mechanism and leaves `/settings` as the
last comment-destructive user-facing writer.

## Recommendation

Choose A. Keep the batch edit type internal to `@mycli/config`; export only existing typed domain
operations. Preserve setup's documented cross-file partial-success boundary: config and auth store
remain separate atomic files, while every config-file edit within setup is one atomic batch.

## Relevant contracts

- `.trellis/spec/backend/configuration-trust-contract.md`
- `.trellis/spec/backend/runtime-tui-gateway-contract.md`
- `backend/packages/config/src/private-file-writer.ts`
- `backend/packages/config/src/user-config-editor.ts`
- `/Users/cosmos/Downloads/codex-main/codex-rs/core/src/config/edit.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/app/config_persistence.rs`
