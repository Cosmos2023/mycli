# OMX Roadmap Gap Audit

## Scope

This audit compares `.omx/plans/mycli-configuration-and-ux-optimization-plan.md` with the current
Node/TypeScript implementation, the archived `08-30-*` Trellis tasks, the active profile/system
layer task, and the current CLI surface. It records delivery evidence and remaining work; it is not
an instruction to reimplement completed phases.

## Current Delivery Evidence

| OMX phase | Current state | Evidence | Remaining gap |
| --- | --- | --- | --- |
| 0 Baseline and UX contracts | Mostly delivered | Configuration trust/schema fixtures, architecture contracts, startup profiling, and provider-free journey tests | Consolidated journey baseline report and explicit drift gates are incomplete |
| 1 Config kernel and trust | Substantially delivered | `08-30-config-trust-foundation`, `08-30-config-schema-diagnostics`, and `08-31-configuration-profiles-system-layers` | Finish canonical reference/version/migration contracts and close remaining compatibility assertions |
| 2 Config service, CLI, profiles, migration | Partially delivered | `config validate/show/get/set/unset`, safe serialized writes, source metadata, and launch-scoped `--profile` | `config path`, migration preview/apply/rollback, generated reference, and explicit optimistic version behavior remain |
| 3 First-run/auth/model | Substantially delivered | `08-30-unified-settings-persistence`, `08-30-session-scoped-model-selection`, and `08-30-phase3-startup-readiness` | One staged first-run journey, complete auth management commands, and non-TTY setup contract remain |
| 4 Permissions/sandbox | Substantially delivered | `08-30-phase4-permission-sandbox-status` | CLI exposes `sandbox status` only; setup/reset and focused cross-platform recovery remain |
| 5 Settings and discovery | Delivered | `08-30-phase5-settings-command-discovery` acceptance criteria are complete | Only regression/drift maintenance remains |
| 6 Session continuity | Delivered | `08-30-phase6-session-continuity-recovery` acceptance criteria are complete | Only regression/drift maintenance remains |
| 7 Diagnostics/updates | Substantially delivered | `08-30-phase7-diagnostics-error-recovery-updates` added typed diagnostics, doctor detail, support metadata, and cached updates | Deterministic `doctor --fix` preview/apply and an exportable redacted support bundle remain |
| 8 Accessibility/terminal/non-TTY | Early/partial | Existing width, CJK/IME, paste, focus, and rendering regressions cover part of the target | Keymaps, semantic color modes, reduced motion, ASCII fallback, capability UX, shell completions, and explicit non-TTY behavior remain |
| 9 Rollout/compatibility | Partial foundation | npm packaging, release verification, and cross-platform CI exist | Upgrade/downgrade/migration artifact matrix, compatibility windows, rollout docs, and final UX budgets remain |

## Revised Codex-Parity Boundary

- Keep profile selection launch-scoped through `--profile`/`-p`.
- Do not add a persisted active profile or `profile list/create/delete/use` manager solely because
  the original OMX plan listed one; the inspected Codex profile-v2 behavior does not require it.
- Preserve mycli-specific provider support, settings catalog, and Node architecture where they
  already satisfy the behavioral contract.
- Do not redesign the agent loop, tool runtime, provider request assembly, compaction, or storage
  schema as part of this roadmap unless a narrowly scoped contract change is required.

## Recommended Remaining Work Packages

1. UX baseline and drift gates.
2. Configuration migration and generated reference.
3. Unified onboarding and auth management.
4. Sandbox setup/reset and platform recovery.
5. Diagnostic repair and support bundle completion.
6. Terminal accessibility, completions, and non-TTY behavior.
7. Release compatibility and final rollout verification.

The packages are deliberately delta-based. Completed Phase 0-7 Trellis tasks remain evidence and
must not be recreated as pending implementation work.

## Constraints

- The current `08-31-configuration-profiles-system-layers` task has committed implementation and
  documentation but still needs normal Trellis archive/journal bookkeeping.
- Existing dirty Windows sandbox and cross-platform CI files predate this roadmap. A future sandbox
  child task must reconcile ownership before touching them; planning must not stage, revert, or
  silently absorb them.
- Full workspace tests currently have an independently reproducible Worker/subagent timing failure
  class. Each child must distinguish regressions from that baseline and cannot claim a green full
  gate without evidence.
