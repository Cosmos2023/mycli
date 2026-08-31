# Configuration Migration And Generated Reference

## Goal

Finish the remaining OMX Phase 1-2 configuration lifecycle: users can locate, validate, understand,
preview-migrate, apply, and roll back configuration through typed, redacted, atomic operations.

## Depends On

- `08-31-ux-baseline-drift-gates`.
- Archived `08-31-configuration-profiles-system-layers` evidence.

## Requirements

- Add `mycli config path` for supported scopes with deterministic platform paths and JSON output.
- Add strict validation behavior and generate a versioned configuration reference/example from the
  canonical setting/schema descriptors.
- Implement `config migrate --dry-run` and explicit apply/rollback operations for supported legacy
  keys/files, including timestamped private backups and a bounded diff preview.
- Validate both the target document and effective configuration before replace; preserve the source
  byte-for-byte on validation, version, permission, or persistence failure.
- Detect concurrent edits through a stable layer version or equivalent expected-version contract.
- Report higher-layer overrides and provenance without exposing the overridden value or credentials.
- Keep profile selection launch-scoped through `--profile`/`-p`; profile/system layers stay
  read-only through provider-free mutation commands.

## Acceptance Criteria

- [x] `config path`, strict validation, migration preview/apply/rollback, text output, and JSON output
  have parser and provider-free integration coverage.
- [x] Preview performs no write; apply creates a private backup; rollback restores the exact prior
  bytes and never touches `auth.json`.
- [x] Concurrent mutation returns a version conflict rather than overwriting a completed writer.
- [x] Unknown/deprecated keys, invalid values, and syntax errors identify a bounded layer/key/range
  and safe remediation.
- [x] Generated schema/reference/docs pass a drift check.
- [x] User, trusted project, launch profile, system, legacy, environment, and session precedence stays
  consistent with the canonical resolver.

## Technical Approach

Extend the existing config resolver and lossless serialized mutation kernel instead of adding a
parallel parser. Represent preview/apply/rollback as typed management operations, with migration
plans carrying expected source versions and redacted changes.

## Decision (ADR-lite)

Use explicit migration transactions and launch-scoped profiles. Do not implement persistent
profile activation or CRUD commands because they exceed the inspected Codex profile-v2 contract.

## Definition Of Done

- Unit/integration/CLI tests plus lint, typecheck, contracts, build, and packed app smoke pass.
- Configuration architecture, README/reference, command docs, and troubleshooting are updated.
- The task is committed, archived, and journaled independently.

## Out Of Scope

- Credential migration into TOML, OAuth, OS keychain work, or automatic migration during read.
- Profile manager commands or edits to system configuration.
- TUI redesign beyond consuming the canonical migration/diagnostic result if needed.

## Technical Notes

- Parent: `08-31-codex-ux-roadmap-completion`.
- Likely ownership: config package, management config/parser/render/services, contracts, docs.
