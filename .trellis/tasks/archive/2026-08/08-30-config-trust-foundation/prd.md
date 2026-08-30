# P0 Configuration Trust Boundary And Provenance Foundation

## Goal

Make startup configuration deterministic and explainable while ensuring that project-local
configuration cannot affect mycli before the workspace trust decision has been made.

## Requirements

- Resolve canonical workspace trust before loading or applying `<workspace>/.mycli/config.toml`.
- Treat the project configuration layer as disabled when the workspace is not trusted, with the
  stable reason `workspace_not_trusted`.
- Introduce a minimal typed configuration layer contract that records layer identity, source,
  enabled state, disabled reason, and configuration version/provenance metadata.
- Preserve the current `resolveConfig` public entry point while adopting the agreed precedence
  `session/CLI > environment > trusted project > user > legacy user > defaults`.
- Keep user and legacy configuration available according to the existing compatibility policy.
- Make effective configuration resolution expose enough metadata for later doctor/settings work to
  explain which layer supplied a value and which layers were overridden or disabled.
- Keep pure layer ordering and provenance decisions separate from filesystem and trust-store IO.
- Add focused unit and integration coverage for trust and precedence behavior.

## Acceptance Criteria

- [x] An untrusted workspace cannot change provider, endpoint, model, execution policy, tools, hooks,
      plugins, MCP configuration, or other runtime settings through `.mycli/config.toml`.
- [x] A trusted workspace loads project configuration above user and legacy configuration but below
      environment and session/CLI overrides.
- [x] The resolved layer stack includes a disabled project layer with reason
      `workspace_not_trusted` when trust is absent.
- [x] Per-setting provenance identifies the winning source and any overridden sources for supported
      configuration values.
- [x] `resolveConfig` remains source-compatible for current callers.
- [x] Tests cover user-only, project-only, trusted project, untrusted project, legacy fallback,
      environment/CLI override, malformed layer, and missing-file cases where currently supported.
- [x] Relevant tests, TypeScript type checking, lint, and contract drift checks pass.

## Definition Of Done

- The runtime determines workspace trust before project-local configuration or project-local
  integrations can become active.
- Configuration layer/provenance contracts are implemented in the config package and exercised by
  tests.
- Existing callers retain a compatibility path while new callers can consume resolution metadata.
- User-facing configuration documentation states the project trust boundary and precedence order.
- The change is reviewed against the repository quality gates without touching unrelated Windows
  sandbox work already present in the worktree.

## Technical Approach

Add a typed, pure configuration-layer resolver inside `backend/packages/config`. Filesystem adapters
will load user, project, and legacy candidates into layer inputs. The project candidate is admitted
only after the canonical workspace trust store has been read. The resolver will return both the
effective configuration and structured metadata while the existing `resolveConfig` facade continues
to return the compatibility shape expected by current callers.

Runtime assembly in `backend/apps/mycli` will be reordered so the workspace root and trust decision
exist before configuration resolution. Project-local integration discovery will consume the same
trust result rather than performing an independent or later decision.

## Decision (ADR-lite)

**Context:** Project configuration is currently resolved before workspace trust is loaded. The
resolver also discards the origins of winning values, which prevents reliable diagnostics and makes
future settings UX ambiguous.

**Decision:** Model configuration as an ordered stack of typed layers. Keep disabled layers in the
resolution result, use `workspace_not_trusted` as the stable project-layer gate reason, and retain
`resolveConfig` as a compatibility facade.

**Consequences:** Runtime startup gains an explicit trust dependency and config resolution returns a
richer internal result. This adds a small amount of type surface now, but avoids duplicating trust,
precedence, and diagnostics logic in later onboarding and settings work. The first slice will not
attempt a complete schema rewrite.

## Out Of Scope

- A complete `/settings` redesign or interactive configuration editor.
- First-run onboarding, login, or model-selection redesign.
- Named profiles and per-command temporary overrides beyond existing behavior.
- Update checking, migration UI, backup/restore UI, or full config schema replacement.
- Credential store redesign.
- Changes to compaction, provider request assembly, the agent loop, or storage schemas.
- Unrelated Windows sandbox and release-pipeline work already modified in this worktree.

## Technical Notes

- Primary modules: `backend/packages/config/src/settings.ts`,
  `backend/packages/config/src/workspace-trust-store.ts`, and
  `backend/apps/mycli/src/node-runtime/node-backend.ts`.
- Follow the existing npm workspace, Node.js `>=22.19.0`, TypeScript strict-mode, and `node:test`
  conventions.
- Configuration sources must not log credentials, API keys, tokens, or raw secret values.
- The long-term UX plan is recorded in `.omx/plans/mycli-configuration-and-ux-optimization-plan.md`.
