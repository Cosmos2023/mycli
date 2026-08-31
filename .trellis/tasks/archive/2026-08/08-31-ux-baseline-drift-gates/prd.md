# UX Baseline And Contract Drift Gates

## Goal

Close the OMX Phase 0 evidence gap by defining deterministic, provider-free user journeys and
cross-surface drift checks before the remaining UX work changes behavior.

## Depends On

- Archive bookkeeping for `08-31-configuration-profiles-system-layers`.

## Requirements

- Add reusable journey fixtures for fresh install, missing credential, malformed user config,
  untrusted project config, model scope, permission changes, resume repair, narrow/CJK terminal, and
  incomplete Windows sandbox readiness.
- Record sanitized baseline measurements for startup/first paint and interaction steps to a ready
  composer; do not record prompts, credentials, tool content, or absolute user paths.
- Add drift checks across root help, management parser, slash-command registry, settings catalog,
  gateway contracts, and command/config documentation.
- Define explicit UX budgets for cancellation, width safety, duplicate errors, background network
  work, and selector response.
- Reuse existing tests and fixtures instead of introducing a second journey harness where possible.

## Acceptance Criteria

- [x] Every listed journey has a deterministic provider-free test or scripted smoke.
- [x] Baseline artifacts are sanitized, stable across machines, and reviewable in CI.
- [x] A command or setting added to one canonical registry cannot silently drift from help/docs/TUI.
- [x] Startup and first-paint measurements fail only on an explicit, documented budget regression.
- [x] macOS, Linux, and Windows path/terminal variants are represented without host-specific writes.

## Technical Approach

Build a thin fixture layer over the existing CLI, gateway, and TUI test harnesses. Generate parity
manifests from canonical descriptors and compare normalized output rather than duplicating lists in
tests.

## Definition Of Done

- Focused tests plus lint, typecheck, contracts, and applicable packed smoke pass.
- Baseline report and maintenance instructions are documented.
- The task is committed, archived, and journaled independently.

## Out Of Scope

- Implementing migration, onboarding, sandbox repair, accessibility controls, or release behavior.
- Real provider calls or telemetry collection.
- Changing product behavior solely to make a baseline pass.

## Technical Notes

- Parent: `08-31-codex-ux-roadmap-completion`.
- Source: OMX Phase 0 and Quality Strategy.
- Preserve existing unrelated Windows sandbox/CI work.
