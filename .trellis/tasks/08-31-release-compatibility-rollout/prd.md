# Release Compatibility And Rollout Verification

## Goal

Complete OMX Phase 9 by proving the finished configuration and UX behavior from packed npm artifacts
across supported platforms and documenting its upgrade, downgrade, migration, and compatibility
contracts.

## Depends On

- `08-31-config-migration-reference`.
- `08-31-unified-onboarding-auth`.
- `08-31-sandbox-setup-platform-recovery`.
- `08-31-diagnostic-repair-support-bundle`.
- `08-31-terminal-accessibility-nontty`.

## Requirements

- Test fresh install, upgrade, downgrade, migration preview/apply/rollback, session resume, update
  notice, and sandbox readiness from packed npm artifacts on macOS, Ubuntu, and Windows.
- Define supported config/catalog/session compatibility windows and stable deprecation metadata with
  introduction, removal, replacement, and migration guidance.
- Enforce startup and first-render budgets without allowing update/diagnostic network work to block.
- Verify package names, entrypoints, native helper/ripgrep selection, shell completions, no-color
  output, and non-TTY management commands from installed artifacts rather than source imports.
- Update changelog, release notes, command/config references, troubleshooting, Windows setup, and
  upgrade/rollback guidance.
- Keep any metrics local and fixture-based; do not introduce telemetry as a release requirement.

## Acceptance Criteria

- [ ] The supported three-platform packed-artifact matrix passes or records a specific external
  infrastructure blocker without hiding product failures.
- [ ] Upgrade/downgrade and migration rollback preserve documented data/config compatibility.
- [ ] No background update, doctor, or migration work regresses startup/first-paint budgets.
- [ ] Release docs and generated references match shipped parser/contracts through drift checks.
- [ ] Secret/path/redaction scans pass over JSON, logs, support artifacts, snapshots, and release
  evidence.
- [ ] The parent roadmap's eight definition-of-done outcomes are demonstrated by linked evidence.

## Technical Approach

Extend existing release verification and packed-smoke infrastructure with version-pair fixtures and
platform-owned sandbox checks. Treat source-tree tests as prerequisites, not substitutes for installed
artifact evidence.

## Definition Of Done

- All prerequisite children are archived with green scoped gates.
- The release matrix, performance evidence, docs, and compatibility policy are committed.
- The parent roadmap can be closed without unresolved in-scope acceptance criteria.

## Out Of Scope

- Telemetry backend, automatic package-manager execution, or silent self-update.
- Publishing a release without explicit user authorization.
- Broad runtime/tool/compaction work unrelated to a failed UX compatibility gate.

## Technical Notes

- Parent: `08-31-codex-ux-roadmap-completion`.
- This task is the final convergence gate and must not start early.
