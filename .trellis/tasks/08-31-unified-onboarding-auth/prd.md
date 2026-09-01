# Unified Onboarding And Auth Management

## Goal

Complete the OMX Phase 3 first-run journey so a fresh user reaches a ready, authenticated, trusted
composer through one coherent, cancelable flow built from existing mycli components.

## Depends On

- `08-31-config-migration-reference`.

## Requirements

- Compose welcome, credential source, provider/model, optional connectivity validation, workspace
  trust, permission preset, and ready states under one explicit ordered onboarding state machine.
- Queue only stages required by the authoritative startup state. Complete auth plus resolved trust
  must continue directly to the composer without replaying onboarding.
- Reuse existing setup, login, model, trust, and permission components and canonical backend
  readiness data; do not create duplicate stores or selectors.
- Keep every step keyboard-complete and Esc-cancelable. Canceling an active stage performs no write
  for that stage; canceling a required startup stage exits without exposing an unusable composer.
  Previously confirmed durable decisions remain in place.
- Preserve the existing focused submit-time credential recovery path. It must retain the composer
  draft and must not restart the full onboarding journey.
- Complete provider-free `login status`, stdin-only API-key login, logout, and safe credential
  replacement. Provider configuration plus credential replacement is one logical rollback-safe
  operation and must preserve unrelated auth references.
- Define non-TTY setup inputs without exposing secrets in argv, logs, transcripts, snapshots, JSON,
  or process listings.
- Make connectivity validation deliberate and optional, default it to Skip, and keep offline setup
  valid. Unit and integration tests must not require a real provider.
- Preserve session-only versus user-default model/reasoning choices.
- Keep repository configuration and integrations disabled until workspace trust is successfully
  persisted and the backend has reloaded the trusted state.

## Acceptance Criteria

- [x] A fresh temporary home can reach a ready composer without hand-editing files.
- [x] Esc at every stage performs no write for that active stage; required-stage cancellation exits,
  and submit-time authentication cancellation retains the composer draft.
- [x] A failed provider config or credential replacement restores both previous files byte-for-byte
  and preserves unrelated credential entries.
- [x] Missing, malformed, replaced, environment-provided, and custom-auth-reference credentials have
  provider-free regression coverage.
- [x] Workspace trust is resolved before project configuration or integrations become active.
- [x] Session model choices survive restart without silently changing user defaults.
- [x] Non-TTY setup either completes through explicit safe inputs or returns one actionable usage
  error without starting the TUI.
- [x] `login status` and `logout` work without provider access; `login --with-api-key` reads only
  non-TTY stdin and no supported command accepts a secret value in argv.

## Technical Approach

Add one orchestration state machine over existing authoritative readiness/control operations. The
ordered stages are Welcome, Credential, Model/reasoning/scope, optional Connectivity, Trust,
Permission, and Ready; only required stages are queued. Keep secret input at the auth-store
boundary and persist each durable decision only after its explicit confirmation. Use typed
provider-free auth-store status/delete operations and a rollback-safe config-plus-credential
replacement boundary for management setup/login.

## Definition Of Done

- Backend/gateway/TUI journey tests plus lint, typecheck, contracts, build, and packed app smoke pass.
- Setup/login/model/trust documentation describes scope, cancellation, and offline behavior.
- The task is committed, archived, and journaled independently.

## Out Of Scope

- OAuth/device code, browser login, OS keychain integration, or automatic provider calls.
- New profile-management semantics.
- Visual rebranding or a marketing welcome screen.

## Technical Notes

- Parent: `08-31-codex-ux-roadmap-completion`.
- Reuse Phase 3 startup readiness rather than replacing its submit-time auth gate.
- Codex and current-repo evidence: [`research/codex-onboarding-auth-parity.md`](research/codex-onboarding-auth-parity.md).

## Decision (ADR-lite)

**Context:** Startup currently chains several selectors imperatively while standalone setup owns a
second partial journey. Auth management lacks provider-free status/logout, and config plus secret
writes can diverge on failure.

**Decision:** Add a TUI stage coordinator that composes the existing selectors and authoritative
gateway operations. Match Codex's ordered, cancelable, only-when-required onboarding behavior while
retaining mycli's explicit model scope and permission stages. Add provider-free auth management and
stdin-only non-TTY credential input.

**Consequences:** The coordinator adds no new durable store. Completed decisions may survive a
later canceled step, but the active canceled step never writes. Configuration and credential
replacement need an explicit rollback boundary, and trusted repository inputs require a reload
after trust is accepted.
