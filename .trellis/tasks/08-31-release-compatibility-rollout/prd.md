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
- [x] Upgrade/downgrade and migration rollback preserve documented data/config compatibility.
- [x] No background update, doctor, or migration work regresses startup/first-paint budgets.
- [x] Release docs and generated references match shipped parser/contracts through drift checks.
- [x] Secret/path/redaction scans pass over JSON, logs, support artifacts, snapshots, and release
  evidence.
- [x] The parent roadmap's eight definition-of-done outcomes are demonstrated by linked evidence.

## Technical Approach

Extend existing release verification and packed-smoke infrastructure with version-pair fixtures and
platform-owned sandbox checks. Treat source-tree tests as prerequisites, not substitutes for installed
artifact evidence.

The real predecessor is `@cosmos2023/app@0.1.0`; the current public application identity is
`@cosmos2023/mycli`. The feature branch predates that rename and must first restore the public package
identity without merging unrelated `main` task state. Do not publish or choose a new semver as part of
this task.

## Implementation Batches

1. Restore the canonical public npm identity and define machine-readable compatibility,
   deprecation, and predecessor metadata with drift tests.
2. Extend packed-artifact smoke coverage for fresh install, configuration migration
   preview/apply/rollback, session resume, update, sandbox readiness, completion, color, and non-TTY
   management journeys.
3. Add a registry-backed legacy-package upgrade/downgrade journey that distinguishes external
   registry blockers from product failures and never uses real credentials.
4. Add an independently visible three-platform CI gate with sanitized evidence and startup budget
   enforcement.
5. Complete changelog, release notes, compatibility, upgrade/rollback, troubleshooting, Windows,
   and generated-reference documentation, then link the parent roadmap outcomes to evidence.

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
- Predecessor and branch audit: [`research/published-predecessor.md`](research/published-predecessor.md).

## Verification Evidence

Verified locally on macOS arm64 with Node 24.14.1 on 2026-09-01:

- `npm run lint`, `npm run typecheck`, `npm run contracts:check`, `npm run config:check`, full
  `npm test`, `npm run release:compatibility`, and `git diff --check` passed.
- The packed current-host journey previously completed all eight installed-artifact checks.
- The real registry journey passed predecessor install, candidate migration, downgrade readability,
  candidate reinstall, and migration rollback. Its ignored `release-evidence/local.json` contains
  five fixed check ids, no local paths or command/provider content, and mode `0600`.
- `npm run smoke:package -- --all-platforms` was attempted during final verification. Packaging
  reached `linux-x86_64`, then the fixed ripgrep GitHub release asset failed with
  `UND_ERR_CONNECT_TIMEOUT`; a direct bounded staging retry and HTTPS probe reproduced the same
  external network blocker. No product failure was waived or recorded as a pass.
- `.github/workflows/release-compatibility.yml` and the strict tag workflow are structurally tested,
  but the candidate commit has not yet run on the macOS, Ubuntu, and Windows GitHub runners. The
  first acceptance item remains pending until that matrix produces evidence or records its own
  platform-specific external blocker.
