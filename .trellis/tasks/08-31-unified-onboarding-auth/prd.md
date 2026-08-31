# Unified Onboarding And Auth Management

## Goal

Complete the OMX Phase 3 first-run journey so a fresh user reaches a ready, authenticated, trusted
composer through one coherent, cancelable flow built from existing mycli components.

## Depends On

- `08-31-config-migration-reference`.

## Requirements

- Compose welcome, credential source, provider/model, optional connectivity validation, workspace
  trust, permission preset, and ready states under one explicit onboarding state machine.
- Reuse existing setup, login, model, trust, and permission components and canonical backend
  readiness data; do not create duplicate stores or selectors.
- Keep every step keyboard-complete and Esc-cancelable, preserving the composer draft and avoiding
  partial configuration or credential writes.
- Complete provider-free auth status/logout management behavior and safe credential replacement.
- Define non-TTY setup inputs without exposing secrets in argv, logs, transcripts, snapshots, JSON,
  or process listings.
- Make connectivity validation deliberate and optional; offline setup remains valid.
- Preserve session-only versus user-default model/reasoning choices.

## Acceptance Criteria

- [ ] A fresh temporary home can reach a ready composer without hand-editing files.
- [ ] Cancel at every stage leaves configuration/auth bytes unchanged and retains applicable drafts.
- [ ] Missing, malformed, replaced, environment-provided, and custom-auth-reference credentials have
  provider-free regression coverage.
- [ ] Workspace trust is resolved before project configuration or integrations become active.
- [ ] Session model choices survive restart without silently changing user defaults.
- [ ] Non-TTY setup either completes through explicit safe inputs or returns one actionable usage
  error without starting the TUI.

## Technical Approach

Add one orchestration state machine over existing authoritative readiness/control operations. Keep
secret input at the auth-store boundary and persist each durable decision only after its explicit
confirmation.

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
