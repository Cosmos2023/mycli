# Configuration Profiles And System Layers

## Goal

Close the highest-value remaining Phase 1-2 configuration gaps by adding deterministic,
launch-selected profile and system configuration layers while preserving the existing trust,
provenance, validation, credential, and atomic-write boundaries.

## What I Already Know

- The approved configuration and UX roadmap defines precedence above built-in defaults as session,
  environment, trusted project, selected profile, user, system, then legacy user configuration.
- The current implementation supports session, environment, project, user, and legacy-user layers;
  profile and system layers are absent.
- Existing config inspection and mutation commands already expose typed, value-safe diagnostics and
  must remain the only management boundary rather than introducing a second parser.
- Credentials stay in the auth store. Profile and system configuration must reject inline secrets.
- System configuration is machine-owned/read-only from ordinary mycli commands.
- Work remains inline; no subagent may be started.
- Seven unrelated Windows sandbox and CI files are dirty and must not be modified, staged, reverted,
  or committed by this task.

## Requirements

- Add `mycli --profile <name>` as a launch-only selector matching Codex profile-v2 semantics.
- Validate profile names before path construction using the portable ASCII grammar
  `[A-Za-z0-9_-]+`; reject blank names, paths, separators, dots, and traversal.
- Load `~/.mycli/config.toml` first and `~/.mycli/<name>.config.toml` as a sparse profile layer on
  top. A missing selected profile file is an enabled empty layer, matching Codex.
- Add the read-only system layer at `/etc/mycli/config.toml` on Unix and
  `%ProgramData%\\mycli\\config.toml` on Windows, with `C:\\ProgramData` fallback.
- Resolve normal values in descending precedence as session, environment, trusted project,
  selected profile, user, system, legacy user, then defaults.
- Add profile and system to the canonical typed layer stack with deterministic provenance,
  source metadata, and bounded read/parse/schema diagnostics.
- Keep project configuration trust-gated and keep all credential values outside profile/system TOML.
- Keep existing provider-free config mutations user-only; profile and system layers are read-only to
  ordinary mycli management commands in this batch.
- Preserve compatibility for installations with no profile/system configuration.

## Acceptance Criteria

- [ ] Every effective setting reports profile/system provenance and the documented precedence.
- [ ] Missing profile/system files preserve current behavior byte-for-byte at public boundaries.
- [ ] Untrusted project config cannot outrank or influence the selected profile.
- [ ] `--profile` reaches new sessions and resumed sessions as launch-scoped loader input without
  writing user config or session state.
- [ ] Invalid profile names fail before backend/TUI startup and cannot escape the mycli home.
- [ ] Profile/system unknown-key warnings and fatal diagnostics identify only their stable layer id;
  configured values, credentials, source text, and absolute paths never cross public boundaries.
- [ ] Existing `config set/unset` continue to mutate only `~/.mycli/config.toml`.
- [ ] macOS/Linux and Windows system paths are deterministic and unit tested without host writes.
- [ ] Focused config/CLI/runtime tests plus lint, typecheck, contracts, and workspace tests pass.

## Definition Of Done

- One canonical resolver owns all layer order and provenance.
- Interactive runtime and tests consume the same launch-selected profile behavior; system config is
  shared by runtime, doctor, and management resolution.
- User documentation and executable Trellis contracts describe paths, precedence, validation, and
  rollback.
- Work is committed, archived, and journaled without unrelated Windows/CI changes.

## Out Of Scope

- Profile list/show/create/delete/use commands or a persisted active-profile state.
- Profile-scoped config mutation, TUI profile selection/editing, and `MYCLI_PROFILE`.
- Automatic migration or rewriting of existing user/project configuration.
- Managed enterprise constraints and remote policy distribution.
- Shell completion generation.
- Secrets, OAuth, or keychain storage inside profile files.

## Technical Notes

- Plan source: `.omx/plans/mycli-configuration-and-ux-optimization-plan.md`, Phases 1-2.
- Relevant current modules include `backend/packages/config/src/config-layers.ts`, `settings.ts`,
  `config-schema.ts`, and the management config/parser/service modules under
  `backend/apps/mycli/src/management/`.
- Relevant executable contract: `.trellis/spec/backend/configuration-trust-contract.md`.

## Research References

- [`research/current-config-kernel.md`](research/current-config-kernel.md) — the existing loader is
  canonical, but runtime source order and provenance inputs must be extended together.
- [`research/codex-config-layers.md`](research/codex-config-layers.md) — Codex models profiles as
  external loader selection plus a sparse layer and uses explicit Unix/Windows system paths.
- [`research/profile-activation-patterns.md`](research/profile-activation-patterns.md) — documents
  broader activation patterns considered and explicitly rejected for this Codex-parity batch.

## Decision (ADR-lite)

**Context:** Codex exposes profile-v2 as explicit loader input and a sparse config layer. It does
not provide durable profile activation or profile management commands.

**Decision:** Match that contract directly: one validated `--profile` argument resolves one sparse
`~/.mycli/<name>.config.toml` layer. Do not introduce management commands or activation state.

**Consequences:** The implementation stays small, deterministic, and recognizable to Codex users.
Users create profile files manually and select them per launch. A richer profile manager can be
designed later without compatibility obligations from this batch.

## Implementation Plan

1. Extend config layer ids, scopes, file diagnostics, and platform path resolution.
2. Add typed profile-name parsing and load system/user/profile/project layers in canonical order.
3. Parse and propagate `--profile` through CLI startup and the Node backend config resolver.
4. Add precedence, trust, validation, redaction, CLI, resume, and cross-platform path tests.
5. Update the executable configuration contract and user-facing CLI/config documentation.
