# Configuration Migration Kernel Research

## Existing Ownership

- `backend/packages/config/src/settings.ts` is the only canonical resolver. It loads the ordered
  session, environment, trusted project, selected profile, user, system, and legacy-user layers and
  produces both effective values and provenance.
- `backend/packages/config/src/runtime-setting-catalog.ts` and
  `shell-setting-catalog.ts` already define the supported setting allowlist, canonical write paths,
  legacy aliases, value kinds, and TUI descriptions.
- `backend/packages/config/src/user-config-editor.ts` owns lossless TOML patching and validates a
  candidate once as an isolated user document and once in the complete effective stack.
- `backend/packages/config/src/private-file-writer.ts` owns the per-file lock, private modes,
  temporary-file fsync, atomic replace, and directory fsync.
- `backend/apps/mycli/src/management/` is the provider-free parser, service, response, and rendering
  boundary. Configuration commands must stay there and must not construct a provider or TUI.

## Missing Contracts

- The setting catalog does not expose one combined reference descriptor or descriptions for runtime
  settings, so generated reference artifacts cannot currently be checked for drift.
- The private writer serializes concurrent writers but has no caller-visible expected-version
  contract and no pre-commit hook for a migration backup.
- Configuration diagnostics accept legacy aliases silently, and strict validation has no way to
  turn warnings into a non-zero result.
- Management supports only validate, show, get, set, and unset. It has no path discovery or explicit
  migration preview, apply, and rollback operations.

## Selected Data Flow

```text
descriptors + user bytes + legacy-user bytes
  -> lossless migration plan
  -> bounded value-free changes + composite expected version
  -> apply under the canonical user-config lock
  -> re-read/re-plan and reject stale expected version
  -> validate isolated target and complete effective config
  -> write private timestamped backup record
  -> atomic user-config replace
  -> resolve post-write provenance
```

Rollback loads one closed, private backup record, verifies its checksum and the current user-layer
version, validates the restored target/effective configuration, and restores the prior content (or
prior absence) through the same lock and atomic writer. It never reads or writes `auth.json`.

## Decisions

- A content version is a versioned SHA-256 identity over exact UTF-8 file bytes plus present/absent
  state. A migration preview version binds the schema version, user version, and legacy-user
  version. Hashes are safe to display; source content is not.
- `config migrate --apply` requires the expected version returned by `--dry-run`. This makes a
  preview an optimistic-concurrency contract rather than informational output.
- The legacy user file remains read-only. Supported values missing from the higher-priority user
  file are imported into canonical user paths, but the legacy source is not deleted. This avoids a
  non-atomic two-file cutover while preserving precedence and exact source bytes on every failure.
- Backup records live below `~/.mycli/backups/config`, use private directory/file modes, contain the
  prior bytes as base64 plus integrity/version metadata, and are addressed externally only by a
  bounded backup id.
- Diff rows contain operation, canonical key, source layer, effective source, and overridden layer
  ids. They never contain values, TOML snippets, credentials, or absolute paths and are capped with
  an explicit truncation marker.
- `config path` supports user, project, selected profile, system, and legacy-user scopes. Profile
  names are validated before path construction; profile and system paths remain read-only.
- Strict validation keeps the canonical diagnostic shapes but returns a failure when any warning is
  present. Legacy aliases and the legacy-user file receive bounded deprecation diagnostics.

## Required Verification

- Config-package tests: generated descriptor coverage, legacy diagnostics, candidate preservation,
  stale preview rejection, private backup mode, pre-rename failure preservation, exact rollback,
  rollback conflict, absent-file rollback, redaction, and concurrent writer behavior.
- App tests: parser forms, text/JSON rendering, supported path scopes, strict exit behavior, complete
  provider-free migration flow, and zero provider/TUI startup.
- Drift gate: generated Markdown, JSON reference, and TOML example must match checked-in artifacts.
- Repository gates: lint, typecheck, contracts check, build, focused tests, UX contracts, and packed
  app-only smoke.
