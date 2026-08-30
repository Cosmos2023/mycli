# Phase 3 Startup Readiness And Auth Recovery

## Goal

Detect missing provider credentials before the first paid/provider turn is submitted and route the
user into one coherent, cancelable recovery flow built from the existing setup, login, model, and
trust components. A missing credential must remain an actionable readiness state rather than
degrading into a generic provider failure.

## What I Already Know

- The OMX configuration and UX plan makes this the next unfinished Phase 3 slice.
- Setup, login, model catalog, workspace trust, and model selection components already exist.
- Provider/model and TUI settings now share lossless, serialized persistence.
- Model selection now distinguishes session-only use from a user default.
- The user explicitly requested inline implementation with no subagents.
- Unrelated Windows sandbox and CI changes are present in the worktree and must remain untouched.

## Requirements

- Project current, secret-free credential readiness during bootstrap and evaluate it again before
  accepting every provider-backed turn.
- Sequence unresolved workspace trust before startup login, then focus the composer only after both
  gates are complete.
- Distinguish stored credentials, environment credentials, and missing credentials without exposing
  a secret value; retain a bounded legacy-config source only for existing compatible configuration.
- Preserve a selected model's custom `auth_ref` when saving a credential from recovery.
- Open the existing login flow directly on the current provider when startup or a submit requires
  authentication; Esc still permits returning to the provider list.
- Exit cleanly if startup authentication is canceled. For later recovery, Esc/cancel returns to the
  composer and preserves its draft.
- Successful recovery returns the retained draft to the editor for deliberate resubmission; it must
  not automatically transmit or duplicate the original message.
- Keep readiness provider-free and offline; do not perform implicit connectivity validation.
- Return bounded, stable failures without credentials, submitted prompts, absolute paths, or stack
  traces.
- Preserve existing setup, login, model-selection, session-resume, and configuration behavior.

## Acceptance Criteria

- [x] A provider/model requiring authentication cannot begin a turn when no applicable credential
  source exists; no turn reservation, transcript user message, or provider request is created.
- [x] A stored auth reference or supported environment credential allows submission without opening
  recovery UI.
- [x] Missing credentials open one actionable recovery surface during startup and remain protected
  by a fresh submit-time check.
- [x] Esc/cancel keeps the original composer draft and writes no config or auth data.
- [x] Successful credential recovery retains exactly one draft for deliberate user resubmission and
  supports a custom model-catalog `auth_ref`.
- [x] Visible and structured errors contain no credential value, prompt content, raw provider body,
  absolute local path, or stack trace.
- [x] Unit, integration, TUI, lint, typecheck, contract, release, and package checks pass as relevant.

## Verification Evidence

- `npm test`, `npm run lint`, `npm run typecheck`, `npm run contracts:check`, and
  `npm run release:verify` pass.
- Focused gateway/backend/TUI tests cover the acceptance boundary, all four readiness sources,
  custom references, cancellation, recovery, redaction, and session transition refresh.
- `npm run smoke:package -- --app-only` passes with one packed application. The full platform smoke
  was attempted twice: the first failed while staging ripgrep with `UND_ERR_CONNECT_TIMEOUT`; the
  retry passed staging but stalled in the temporary npm install for more than four minutes and was
  terminated cleanly. No product-code failure was reported.

## Definition Of Done

- Focused backend/gateway and TUI tests cover ready, missing, cancel, success, and failure paths.
- Existing setup, login, model, trust, resume, and provider-error regressions remain green.
- User-facing documentation and executable configuration/TUI contracts reflect the new behavior.
- The implementation is committed, archived, and journaled without unrelated worktree changes.

## Out Of Scope

- OAuth/device-code login or OS keychain integration.
- Provider connectivity calls during startup or readiness evaluation.
- A complete visual redesign of setup, login, model, or trust selectors.
- Phase 4 permission/sandbox productization and the existing Windows sandbox worktree changes.
- Profiles, configuration migration, update checks, telemetry, or non-interactive `exec` mode.

## Technical Approach

- Add one provider-free credential-readiness control operation backed by active session preferences,
  current workspace trust, environment overrides, and `auth.json`.
- Make `turn.submit` await readiness before session preference persistence, reservation, user-message
  lifecycle emission, or runtime submission. Return stable `auth_required` metadata on failure.
- Enrich bootstrap auth rows with current configured/source/auth-reference metadata without secret
  material.
- Let the TUI derive startup auth gating from bootstrap, chain trust into login, and structurally
  handle `auth_required` by restoring the editor draft and opening the existing login component.
- Extend API-key save with an optional bounded `auth_ref` so recovery targets the selected catalog
  identity rather than assuming it equals the provider id.

## Decision (ADR-lite)

**Context**: A TUI-only readiness check is stale and bypassable, while a backend-only check exposes
an apparently ready composer during first run.

**Decision**: Use startup guidance plus an authoritative submit-time gate. Reuse existing selectors
and keep recovery provider-free; do not introduce a parallel setup UI.

**Consequences**: The gateway/control contract gains bounded readiness metadata and async submission.
Startup cancellation exits, while later recovery preserves the draft. Credential connectivity is
not proven until a deliberate provider request is made.

## Expansion Sweep

- Future evolution: the readiness projection can later add endpoint validation and auth expiration
  without changing the TUI's gate contract.
- Related scenarios: model selection and session resume must refresh the same readiness source rather
  than inventing separate booleans.
- Failure cases: external credential deletion, custom auth refs, concurrent saves, canceled input,
  and stale bootstrap state are included; OAuth and keychain migration remain excluded.

## Research References

- [`research/startup-auth-readiness.md`](research/startup-auth-readiness.md) - Codex comparison,
  existing mycli boundaries, alternatives, and edge decisions.

## Technical Notes

- Plan: `.omx/plans/mycli-configuration-and-ux-optimization-plan.md`, Phase 3.
- Likely backend areas: `backend/apps/mycli/src/management/setup.ts`, auth/config packages,
  Node backend/gateway request handling, and session preferences.
- Likely TUI areas: setup/login/model/trust components, shell runtime submission handling, and
  reducer/runtime state.
- The implementation path is `codex-inline`; no implementation, research, or check subagent may be
  started for this task.
