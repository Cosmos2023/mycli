# Sandbox Setup Reset And Platform Recovery

## Goal

Complete OMX Phase 4 by turning restricted-sandbox readiness failures into focused, safe setup and
recovery operations on macOS, Linux, and Windows.

## Depends On

- `08-31-ux-baseline-drift-gates`.
- Explicit ownership resolution for the pre-existing dirty Windows helper and CI files.

## Requirements

- Add canonical `mycli sandbox setup` and `mycli sandbox reset` operations alongside status.
- Expose typed preview, confirmation requirement, privilege/UAC expectation, helper version/state,
  result, and bounded recovery guidance through one management contract.
- Keep platform-specific side effects behind sandbox adapters; CLI/TUI/doctor must not parse native
  stderr or infer readiness independently.
- Never degrade missing/incomplete isolation into implicit full access.
- Make setup idempotent where possible and reset conservative, explicit, and cancel-safe.
- Cover missing dependency, incomplete helper, denied elevation, partial setup, version mismatch,
  successful setup, successful reset, and unsupported platform states.

## Acceptance Criteria

- [x] `sandbox status/setup/reset` text and JSON output derive from the same redacted typed state.
- [x] Setup/reset cannot execute without explicit user intent and return one actionable result.
- [x] Windows UAC denial and incomplete setup expose no raw native stack or noisy duplicate errors.
- [x] macOS/Linux missing sandbox dependencies are detected before the first restricted command where
  the host can determine readiness.
- [x] Managed restrictions remain authoritative across environment, config, session, CLI, and TUI.
- [x] Platform fixtures and packed artifacts cover every supported readiness transition.

## Technical Approach

Extend the existing sandbox readiness service into a state-transition API. Keep elevation and native
helper behavior platform-owned while projecting stable host-level codes and recovery actions.

## Definition Of Done

- Focused platform tests plus lint, typecheck, contracts, build, and relevant package smoke pass.
- Windows and troubleshooting docs describe setup, reset, UAC, logs, and recovery.
- The task is committed, archived, and journaled independently.

## Out Of Scope

- Silent elevation, implicit full access, or automatic dependency/package installation.
- Reworking shell safety classification or approval semantics unrelated to setup readiness.
- Absorbing the current dirty Windows/CI changes without an ownership audit.

## Technical Notes

- Parent: `08-31-codex-ux-roadmap-completion`.
- Protected files must remain untouched during planning.
