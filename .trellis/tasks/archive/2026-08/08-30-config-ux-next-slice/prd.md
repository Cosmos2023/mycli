# Configuration Validation And Inspection Commands

## Goal

Give users a provider-free way to validate configuration and inspect effective settings with their
winning and overridden layers before starting an agent, building on the existing trust, provenance,
and typed diagnostic foundations.

## Requirements

- Add `mycli config validate [--json]` and `mycli config show [--json]` as provider-free management
  commands recognized before TTY, backend, provider, gateway, or TUI startup.
- Both actions must load persisted workspace trust and use `resolveConfigWithMetadata`; they must not
  reconstruct precedence or read an untrusted project config.
- `validate` reports bounded typed diagnostics. Warning-only results succeed with exit `0`; fatal
  configuration errors fail with exit `1`.
- `show` returns an explicit allowlist of effective runtime settings with stable setting keys,
  bounded values, winning layer ids, and overridden layer ids. Values without an explicit origin
  use `default`.
- Credential values are never returned. API-key state may be reported only as `present` or
  `missing`; output must also exclude raw TOML, environment values, stack traces, absolute source
  paths, home/workspace/database paths, and generated session ids.
- Internal source metadata is projected to stable ids only: `session`, `environment`, `project`,
  `user`, `legacy_user`, and `default`.
- Human and JSON rendering consume the same sanitized response object and use deterministic row
  ordering.
- Unknown-key and deprecated-setting diagnostics remain warnings by default; strict validation is
  deferred.
- Existing management commands and configuration files remain backward compatible.

## Acceptance Criteria

- [ ] Parser tests cover both actions, `--json`, missing/unknown actions, extra arguments, and
  duplicate flags.
- [ ] CLI tests prove both commands run with non-TTY streams and start no backend/provider/TUI.
- [ ] A fresh home validates successfully and `show` reports defaults without creating files.
- [ ] Trusted project, environment, and user layers report correct winners and overridden layer ids.
- [ ] An untrusted project file is not read and its layer is reported disabled by the resolver-backed
  workflow.
- [ ] Unknown keys produce deterministic warning diagnostics and exit `0`.
- [ ] Invalid TOML or invalid resolved values produce a bounded diagnostic and exit `1`.
- [ ] Sentinel secrets and absolute paths are absent from human output and serialized JSON.
- [ ] Help and user-facing configuration documentation include the new commands.

## Technical Approach

Add a configuration management service beside the existing doctor/setup/extension services. It
loads workspace trust, invokes the canonical resolver once per command, and projects its result into
closed, read-only response types. A dedicated projection module owns the allowlist, origin mapping,
diagnostic mapping, URL/value bounding, and secret status. The generic management renderer delegates
configuration responses to a focused renderer.

The `show` response includes a version field so later additions can remain additive. Layer rows
include enabled/disabled state and stable disabled reasons, but never their internal `source` path.
Setting rows are sorted by canonical key. Structured values are projected through known serializers,
not arbitrary object stringification.

## Decision (ADR-lite)

**Context**: A validate-only command cannot explain precedence, while a write command would add TOML
editing, credential routing, trust, approval, and concurrent mutation concerns.

**Decision**: Implement read-only `validate + show` using an explicit secret-safe projection.

**Consequences**: Users get a complete preflight and provenance workflow now. `config set`, strict
warning policy, and interactive settings editing remain future work. New visible settings must be
added deliberately to the projection and its redaction tests.

## Definition Of Done

- Relevant unit and integration tests pass.
- Lint, typecheck, contract drift, release checks, and full tests pass.
- User-facing and code-spec documentation is updated when behavior changes.
- The task is committed, archived, and journaled without unrelated worktree changes.

## Out Of Scope

- Unrelated Windows sandbox implementation.
- Reworking provider request assembly, agent execution, storage schemas, or TUI transcript behavior.
- `config set`, file mutation, interactive editing, or TOML comment-preserving updates.
- Provider connectivity/authentication checks; those remain setup/doctor concerns.
- Strict-mode failure for warnings and filtering by individual key/layer.

## Technical Notes

- Completed foundations: archived tasks `08-30-config-trust-foundation` and
  `08-30-config-schema-diagnostics`.
- Research: [`research/config-command-boundary.md`](research/config-command-boundary.md).
- Main implementation areas: `backend/apps/mycli/src/management/`, CLI help, focused app tests,
  README configuration guidance, and the management/configuration contracts.
- Existing Windows sandbox changes are unrelated and must remain untouched, unstaged, and
  uncommitted by this task.
