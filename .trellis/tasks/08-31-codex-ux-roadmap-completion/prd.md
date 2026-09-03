# Codex-Aligned Configuration And UX Roadmap Completion

## Goal

Convert the existing OMX configuration and user-experience roadmap into an executable Trellis
program that closes the remaining Codex-alignment gaps without repeating already delivered work.
The result should take mycli from the current roughly 72% roadmap completion to a release-verified,
cross-platform configuration and UX contract.

## What I Already Know

- The canonical source plan is `.omx/plans/mycli-configuration-and-ux-optimization-plan.md`.
- Archived `08-30-*` Trellis tasks already delivered most of OMX Phases 0-7.
- The active `08-31-configuration-profiles-system-layers` task completed Codex-style launch profiles
  and system layers in commits `f2a93046` and `ea7df894`; only Trellis bookkeeping remains.
- Phase 5 settings/command discovery and Phase 6 session continuity meet their scoped acceptance
  criteria and should remain regression surfaces, not new implementation tasks.
- Phase 8 is the largest untouched product area. Phase 9 has packaging foundations but lacks the
  complete compatibility and rollout matrix.
- The user chose direct Codex behavioral alignment. A persisted profile manager is therefore not a
  required gap.
- Implementation remains inline unless the user later authorizes subagents.

## Requirements

- Preserve the complete OMX Phase 0-9 mapping and document evidence for every phase.
- Schedule only verified remaining gaps; do not reopen archived work without a reproduced defect or
  failed acceptance contract.
- Express each remaining work package as a separate Trellis child task with a focused PRD,
  dependencies, acceptance criteria, quality gates, and explicit out-of-scope section.
- Keep configuration, CLI, gateway, TUI, documentation, and persisted state on canonical typed
  contracts rather than adding presentation-only special cases.
- Match Codex behavior where it establishes user trust: deterministic configuration provenance,
  cancelable setup, visible permissions, actionable errors, terminal adaptation, and predictable
  rollout behavior.
- Preserve secret redaction, workspace trust, approval boundaries, atomic writes, session scope,
  and cross-platform sandbox fail-closed behavior throughout all children.
- Require provider-free deterministic tests for management and readiness paths. Real provider
  calls are optional smoke evidence, never a unit/integration dependency.
- Protect unrelated dirty Windows sandbox and CI work until ownership is explicitly reconciled.
- Keep the parent in `planning` until the child PRDs and dependency order are approved. Do not start
  all children as one large implementation task.

## Phase Status Matrix

| OMX phase | Status | Trellis treatment |
| --- | --- | --- |
| 0 Baseline and UX contracts | Mostly complete | Child 1 closes journey baselines and drift gates |
| 1 Config kernel and trust | Substantially complete | Regression evidence plus Child 2 closeout |
| 2 Config CLI/profiles/migration | Partial | Child 2 implements remaining migration/reference behavior |
| 3 First-run/auth/model | Substantially complete | Child 3 completes the coherent onboarding journey |
| 4 Permissions/sandbox | Substantially complete | Child 4 adds setup/reset and platform recovery |
| 5 Unified settings/discovery | Complete | Regression gate only |
| 6 Session continuity/recovery | Complete | Regression gate only |
| 7 Diagnostics/updates | Substantially complete | Child 5 closes repair/support-bundle gaps |
| 8 Accessibility/terminal/non-TTY | Early | Child 6 is the primary remaining product implementation |
| 9 Rollout/compatibility | Partial | Child 7 owns artifact and release acceptance |

## Execution Status (2026-09-01)

Children 1-6 are archived with their scoped gates complete. Child 7 has implemented the public
package identity, compatibility policy, packed and registry journeys, independent platform
workflow, strict tag gate, release documentation, and the eight-outcome evidence map at
`docs/parity/configuration-ux-release-evidence.md`.

The roadmap remains `6/7` for completion accounting until the candidate commit runs on the macOS,
Ubuntu, and Windows GitHub runners. Local macOS and registry evidence is green; the final local
all-target pack retry recorded `UND_ERR_CONNECT_TIMEOUT` while fetching the fixed Linux x64
ripgrep release asset and did not waive the failure. Promote the roadmap to `7/7` only after the
platform matrix uploads its per-platform evidence or records its own specific external blocker.

## Child Task Plan

### 1. UX Baseline And Contract Drift Gates

**Priority:** P1

Create deterministic fresh-install, missing-auth, malformed-config, untrusted-project, model-scope,
permission, resume, narrow-terminal, and Windows-readiness journeys. Record sanitized baseline
metrics and add drift checks tying CLI help, slash commands, settings descriptors, gateway
contracts, and docs together.

**Depends on:** current profile/system task archived.

### 2. Configuration Migration And Reference Completion

**Priority:** P0

Complete `config path`, versioned configuration reference generation, strict validation, and an
explicit migration preview/apply/rollback flow with backups, redaction, atomicity, and concurrency
protection. Keep launch-scoped profiles and do not add a persisted profile manager.

**Depends on:** Child 1 baseline fixtures and current profile/system task.

### 3. Unified Onboarding And Auth Management

**Priority:** P0

Compose the existing welcome, credential, provider/model, optional validation, trust, permission,
and ready states into one cancelable first-run flow. Complete provider-free auth status/logout and
safe non-TTY setup behavior without exposing secrets through argv or diagnostics.

**Depends on:** Child 2 canonical config/migration contract.

### 4. Sandbox Setup, Reset, And Platform Recovery

**Priority:** P0

Add canonical `sandbox setup/reset` management operations and focused macOS, Linux, and Windows
recovery UX. Preserve fail-closed behavior and reconcile the pre-existing Windows helper/CI work
before any implementation edits those files.

**Depends on:** Child 1 journey harness; existing Windows work ownership resolved.

### 5. Diagnostic Repair And Support Bundle Completion

**Priority:** P1

Add deterministic `doctor --fix` preview/confirmation semantics for safe repairs and an exportable,
bounded, redacted support bundle. Reuse the Phase 7 diagnostic taxonomy and never perform provider
calls, package installation, or privilege escalation implicitly.

**Depends on:** Children 2 and 4 so repair actions target final config/sandbox contracts.

### 6. Terminal Accessibility, Completions, And Non-TTY UX

**Priority:** P1

Deliver configurable keymaps with conflict checks, semantic color capability modes, reduced motion,
ASCII fallback, terminal capability reporting, width/CJK/IME-safe regression coverage, generated
bash/zsh/fish/PowerShell completions, and an explicit non-TTY chat failure or execution contract.

**Depends on:** Child 1 drift harness. May proceed in parallel with Children 3-5 after that gate.

### 7. Release Compatibility And Rollout Verification

**Priority:** P0 release gate

Test fresh install, upgrade, downgrade, migration preview/apply/rollback, and sandbox readiness from
packed npm artifacts on macOS, Ubuntu, and Windows. Enforce startup/first-paint budgets and finish
compatibility windows, changelog, command/config references, troubleshooting, Windows guidance, and
release notes.

**Depends on:** Children 2-6 complete.

## Dependency Order

```text
Current profile/system task archive
  -> Child 1 baseline/drift
      -> Child 2 config migration/reference
          -> Child 3 onboarding/auth
          -> Child 5 diagnostics repair/support bundle
      -> Child 4 sandbox recovery
          -> Child 5 diagnostics repair/support bundle
      -> Child 6 terminal/accessibility/non-TTY
  -> Child 7 release compatibility and rollout
```

Children 3, 4, and 6 may run independently once their stated prerequisites are complete. Child 7 is
the only final convergence gate.

## Acceptance Criteria

- [ ] Every OMX Phase 0-9 item is mapped to delivered evidence, a child task, or an explicit
  Codex-aligned out-of-scope decision.
- [ ] All seven child tasks have approved PRDs, dependency metadata, implementation/check context,
  and independently testable acceptance criteria.
- [ ] Completed Phase 5/6 behavior stays green without duplicate replacement implementations.
- [ ] Configuration migration and sandbox repair are previewable, cancelable, atomic where they
  write state, and never expose credentials or unrelated local data.
- [ ] A fresh install reaches a ready, trusted, authenticated composer through one coherent flow.
- [ ] CLI, TUI, doctor, settings, docs, and session recovery agree on effective state and source.
- [ ] Primary terminal journeys are keyboard-complete, Esc-cancelable, width-safe, CJK/IME-safe,
  color-capability-aware, and usable without special fonts.
- [ ] Packed npm artifacts pass the defined macOS, Ubuntu, and Windows compatibility matrix.
- [ ] Full quality evidence distinguishes new regressions from the documented Worker timing
  baseline; no child hides a failed gate behind a broad waiver.

## Definition Of Done

- All child tasks are implemented, checked, committed, archived, and journaled in dependency order.
- `npm run lint`, `npm run typecheck`, `npm run contracts:check`, relevant focused tests, and packed
  artifact smoke gates pass for every child.
- The final child runs the complete supported cross-platform matrix and records sanitized evidence.
- Architecture, commands, configuration, troubleshooting, Windows, changelog, and release docs
  describe the shipped behavior and compatibility window.
- No secret, prompt, command content, provider body, or unnecessary absolute path enters diagnostic,
  support, snapshot, JSON, or release artifacts.

## Decision (ADR-lite)

**Context:** The OMX plan is a broad 8-11 engineer-week roadmap, but most Phase 0-7 behavior now
exists through smaller Trellis tasks. Replaying the document literally would duplicate code and
reopen stable contracts. Ignoring the original roadmap would lose its cross-phase acceptance model.

**Decision:** Use a delta-based parent/child Trellis program. Preserve OMX as the source roadmap,
record current delivery evidence, create children only for remaining gaps, and use one final packed
artifact rollout task as the convergence gate. Match Codex launch-scoped profiles rather than
adding the broader profile manager proposed by the older OMX document.

**Consequences:** Progress remains auditable without inflating the backlog. Some original phase
boundaries are consolidated into smaller deliverables, and the final release task cannot begin
until configuration, onboarding, sandbox, diagnostics, and terminal children are complete.

## Out Of Scope

- Reimplementing archived Phase 0-7 work without a reproduced contract failure.
- Persisted active-profile state or profile CRUD commands solely for roadmap checkbox parity.
- OAuth/device-code login, OS keychain integration, telemetry collection, or remote support upload.
- Agent-loop, tool-runtime, provider request assembly, compaction, or storage redesign unrelated to
  a child task's narrow contract.
- Automatic package installation or silent privilege escalation.
- Modifying, staging, reverting, or absorbing pre-existing Windows sandbox/CI changes before their
  ownership is reconciled.

## Research References

- [`research/roadmap-gap-audit.md`](research/roadmap-gap-audit.md) - phase-by-phase evidence,
  revised Codex boundary, and remaining work packages.

## Technical Notes

- Source roadmap: `.omx/plans/mycli-configuration-and-ux-optimization-plan.md`.
- Completed evidence: `.trellis/tasks/archive/2026-08/08-30-*`.
- Current profile/system evidence: `.trellis/tasks/08-31-configuration-profiles-system-layers/`.
- Relevant stable specs include `.trellis/spec/backend/configuration-trust-contract.md` and the
  configuration, session, permission, diagnostics, shell, and TUI architecture documents referenced
  by each child.
- This parent task is planning-only orchestration. Product code must be changed in child tasks, not
  directly under the umbrella task.
