# Journal - Cosmos (Part 1)

> AI development session journal
> Started: 2026-08-03

---



## Session 1: Complete Node runtime M5 state recovery

**Date**: 2026-08-05
**Task**: Complete Node runtime M5 state recovery
**Branch**: `feature/mycli-node-runtime-rewrite`

### Summary

Completed M5 persistent runtime recovery across session state, transcripts, queues, steering, approvals, compaction, workspace memory, restart/resume, parity tests, packaged smoke coverage, CI, rollout guidance, and gateway contracts.

### Main Changes

- Added the bounded `web_fetch` adapter with network-policy, SSRF, pinned-DNS, redirect, transfer,
  content-type, and untrusted-content controls.
- Added deterministic `tool_search` discovery for deferred MCP/plugin schemas with append-only,
  persist-before-expose activation and approval/restart recovery.
- Updated M7 integration smoke, executable contracts, user documentation, and archived the completed
  OpenSpec change after syncing its two capability specs.

### Git Commits

| Hash | Message |
|------|---------|
| `732b0a4e` | (see git log) |
| `d1f6b86f` | (see git log) |
| `189b22e5` | (see git log) |
| `5f755bc9` | (see git log) |
| `9e09de36` | (see git log) |
| `b6bd0e53` | (see git log) |
| `930d6c2c` | (see git log) |
| `d905f36a` | (see git log) |
| `a1f623e4` | (see git log) |
| `63b88c0a` | (see git log) |
| `5174911e` | (see git log) |
| `411412ce` | (see git log) |
| `6c50d8f5` | (see git log) |
| `2ebfb6b2` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: Complete M6 persistent shell

**Date**: 2026-08-05
**Task**: Complete M6 persistent shell
**Branch**: `feature/mycli-node-runtime-rewrite`

### Summary

Completed the Node-owned persistent shell milestone: bounded output, pipe and native PTY/ConPTY transports, session ownership, approvals, sandboxing, lifecycle persistence, backend integration, parity fixtures, live smoke contract, rollout documentation, and cross-platform verification.

### Main Changes

- Added manifest-gated parallel phases for built-in `Read`, `web_fetch`, and
  `tool_search` calls while retaining sequential barriers for mutations,
  approvals, clarification, planning, Shell, and extension tools.
- Preserved provider-order lifecycle completion, result persistence, hooks,
  checkpoints, and replay even when parallel tools finish out of order.
- Tracked active tools by full call id and added interruption, failure,
  approval, barrier, and call-id collision regressions.
- Documented the tool-manifest and provider-replay concurrency contracts.

### Git Commits

| Hash | Message |
|------|---------|
| `ff0b9e26` | (see git log) |
| `9318b85d` | (see git log) |
| `e91ccef7` | (see git log) |
| `2c803893` | (see git log) |
| `62da5544` | (see git log) |
| `9b1d91e3` | (see git log) |
| `0fe3081f` | (see git log) |
| `c0a729f7` | (see git log) |
| `1762c7c1` | (see git log) |
| `c48bc088` | (see git log) |
| `28cfdd3f` | (see git log) |
| `7a2d85c7` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: Complete Node runtime M7 extension parity

**Date**: 2026-08-06
**Task**: Complete Node runtime M7 extension parity
**Branch**: `feature/mycli-node-runtime-rewrite`

### Summary

Completed M7 parity fixtures, no-Python extension smoke, packed and cross-platform gates, MCP schema adaptation, executable contracts, and a successful credential-gated Responses rerun.

### Main Changes

- Added a versioned `ConfigDiagnostic` and `ConfigError` contract owned by `@mycli/config`.
- Centralized the supported TOML vocabulary and emitted deterministic unknown-key/table warnings.
- Rejected project and table-scoped inline credentials while retaining a migration warning for
  legacy user root `api_key` values.
- Preserved TOML line/column metadata and converted provider/protocol failures into value-free
  diagnostics.
- Projected bounded diagnostics through `mycli doctor` and documented the trust/schema boundary.

### Git Commits

| Hash | Message |
|------|---------|
| `95b0e868` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: Complete Node runtime M8 promotion

**Date**: 2026-08-06
**Task**: Complete Node runtime M8 promotion
**Branch**: `feature/mycli-node-runtime-rewrite`

### Summary

Closed Node TUI and slash-command parity, promoted npm startup to Node-only, retained the independently launched Python reference runtime, hardened release gates, and documented the final M8 contract.

### Main Changes

- Added canonical diagnostic categories and recovery actions, fresh per-request occurrence
  identities, and TUI deduplication across response and notification lanes.
- Expanded provider-free doctor output with bounded structured rows, terminal/update collectors,
  redaction, durations, and a safe support manifest.
- Added a private 20-hour update cache, non-blocking startup refresh, exact-version dismissal,
  CLI/gateway/TUI projections, documentation, and regression coverage.

### Git Commits

| Hash | Message |
|------|---------|
| `3965dc46` | (see git log) |
| `86951fa5` | (see git log) |
| `931dce4c` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: Add Node web fetch and deferred tool discovery

**Date**: 2026-08-11
**Task**: Add Node web fetch and deferred tool discovery
**Branch**: `feature/mycli-node-runtime-rewrite`

### Summary

Added secure bounded web_fetch, durable turn-local tool_search activation for MCP/plugin schemas, integration recovery coverage, and archived OpenSpec contracts.

### Main Changes

- Added launch-scoped `--profile` / `-p` selection without persisted active-profile state.
- Added canonical managed, system, profile, project, user, environment, CLI, and session precedence
  with source/override provenance.
- Propagated the selected profile through session startup and Worker-backed agent execution.
- Documented profile discovery, trust behavior, precedence, and validation failures.

### Git Commits

| Hash | Message |
|------|---------|
| `0fc2656d` | feat(node-tools): add secure web fetch and deferred search |
| `932d20c9` | feat(node-runtime): persist deferred tool activation |
| `5acb6bd5` | docs(node-tools): archive web and discovery contracts |

### Testing

- [OK] Root build, typecheck, ESLint, and full npm workspace tests
- [OK] Tools 195/195, runtime 248/248, storage 110/110, app 184/184
- [OK] OpenSpec validation and `git diff --check`

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: Codex-style transcript viewer

**Date**: 2026-08-11
**Task**: Codex-style transcript viewer
**Branch**: `feature/mycli-node-runtime-rewrite`

### Summary

Added Ctrl+T alternate-screen transcript viewing with on-demand append-only Shell output, live-tail refresh, legacy fallback, and PTY coverage.

### Main Changes

- Added typed sandbox readiness and recovery contracts with preview-first setup and reset commands.
- Added conservative Windows helper reset behavior, stable UAC cancellation handling, and CI recovery coverage.
- Documented management commands, platform-specific recovery guidance, and runtime/TUI gateway contracts.

### Git Commits

| Hash | Message |
|------|---------|
| `7d889886` | (see git log) |

### Testing

- [OK] Focused configuration, CLI, session, and Worker profile tests
- [OK] `npm run lint`, `npm run typecheck`, and `npm run contracts:check`

### Status

[OK] **Completed**

### Next Steps

- Continue the remaining Codex-aligned configuration and UX roadmap.


## Session 7: Enable safe parallel tool batches

**Date**: 2026-08-11
**Task**: Enable safe parallel tool batches
**Branch**: `feature/mycli-node-runtime-rewrite`

### Summary

Enabled manifest-gated concurrent execution for safe Node tool phases while preserving provider-order persistence, approvals, hooks, interruption, and sequential barriers.

### Main Changes

- Added a versioned manifest for nine provider-free configuration and terminal UX journeys across
  macOS, Linux, and Windows evidence.
- Exported canonical management command/help surfaces and added drift checks for management docs,
  slash commands, shell settings, and gateway contracts.
- Added explicit first-paint, error, selector, width, cancellation, draft, privacy, and PTY budgets.
- Added the focused `npm run test:ux-contracts` gate, baseline report, and long-term quality spec.

### Git Commits

| Hash | Message |
|------|---------|
| `c6f9a0cf` | feat(node-runtime): execute safe tool batches concurrently |

### Testing

- [OK] `npm run lint`
- [OK] `npm run typecheck`
- [OK] Runtime tests: 254 passed
- [OK] Tools tests: 198 passed
- [OK] App tests: 185 passed
- [OK] TUI tests: 540 passed

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 8: Configuration trust foundation

**Date**: 2026-08-30
**Task**: Configuration trust foundation
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added typed configuration layers and provenance, gated project configuration and repository integrations on canonical workspace trust, made resume use the persisted session workspace, and documented the resulting contract.

### Main Changes

- Added versioned configuration layer and per-key provenance metadata while preserving the
  `resolveConfig` compatibility facade.
- Gated project TOML, execution rules, hooks, MCP, plugins, and repository skills on canonical
  workspace trust.
- Made resumed sessions resolve trust and integrations from the persisted session workspace.
- Added provider-free regression coverage and configuration trust architecture/code-spec docs.

### Git Commits

| Hash | Message |
|------|---------|
| `8ceca308` | feat(config): gate project configuration on workspace trust |
| `d44bb4c4` | docs(config): document trust and provenance contract |

### Testing

- [OK] `npm test`
- [OK] `npm run test:release`
- [OK] `npm run lint`
- [OK] `npm run typecheck`
- [OK] `npm run contracts:check`
- [OK] `git diff --check`

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 9: Configuration schema diagnostics

**Date**: 2026-08-30
**Task**: Configuration schema diagnostics
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added typed value-free configuration schema diagnostics, project credential enforcement, bounded doctor projection, provider/protocol redaction, regression coverage, and user-facing configuration contracts.

### Main Changes

- Added layered terminal capability detection, semantic appearance settings, and validated TUI
  keymap contracts with reset support.
- Projected effective keymaps and bounded terminal capabilities through the Node gateway and
  applied accessible color, glyph, motion, and contrast tokens throughout the TUI.
- Added one canonical CLI catalog plus provider-free Bash, Zsh, Fish, and PowerShell completion.
- Added non-TTY, CJK/IME, paste, resize, width, accessibility, drift, and packed-artifact coverage,
  with matching user and code-spec documentation.

### Git Commits

| Hash | Message |
|------|---------|
| `73ffc27c` | feat(config): add typed schema diagnostics |
| `33bd7c61` | docs(config): document schema diagnostic contract |

### Testing

- [OK] `npm test`
- [OK] `npm run test:release`
- [OK] `npm run lint`
- [OK] `npm run typecheck`
- [OK] `npm run contracts:check`
- [OK] `git diff --check`

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 10: Configuration inspection and MCP shutdown hardening

**Date**: 2026-08-30
**Task**: Configuration inspection and MCP shutdown hardening
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added provider-free config validate/show commands with secret-safe provenance, fixed MCP close to drain in-flight refresh persistence, synchronized executable specs, and passed the full repository quality gates.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `f712ae8e` | (see git log) |
| `b40fe4c4` | (see git log) |
| `e18fe899` | (see git log) |

### Testing

- [OK] All manifest-referenced provider-free journey and budget regressions
- [OK] `npm run test:ux-contracts` (4 passed)
- [OK] `npm run lint`, `npm run typecheck`, `npm run contracts:check`, and `npm run build`
- [OK] Packed CLI smoke with `--app-only`; platform ripgrep download excluded from this task

### Status

[OK] **Completed**

### Next Steps

- Continue with configuration migration and generated reference completion.


## Session 11: Safe configuration mutation CLI

**Date**: 2026-08-30
**Task**: Safe configuration mutation CLI
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added provider-free config get/set/unset commands with a shared typed setting catalog, lossless user-only TOML mutation, lock-scoped candidate validation, atomic writes, provenance reporting, redaction tests, CLI documentation, and executable configuration contracts.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `4524e6fc` | (see git log) |
| `bbb503d6` | (see git log) |
| `68e00929` | (see git log) |

### Testing

- [OK] `npm run lint`
- [OK] `npm run typecheck`
- [OK] `npm run contracts:check`
- [OK] `npm run config:check`
- [OK] `npm run test:ux-contracts`
- [OK] `npm test`
- [OK] `npm run smoke:package -- --app-only`
- [OK] `git diff --check`

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 12: Unified setup and TUI settings persistence

**Date**: 2026-08-30
**Task**: Unified setup and TUI settings persistence
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added one lossless ordered user-config batch editor, migrated provider/model and shell settings writers onto it, passed active workspace trust context from the Node runtime, added no-op/CRLF/concurrency/failure regressions, and documented the cross-layer persistence contract.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `b503c018` | (see git log) |
| `fa8857e8` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 13: Session-scoped model selection

**Date**: 2026-08-30
**Task**: Session-scoped model selection
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added explicit session and user model-selection scopes across contracts, backend, gateway, TUI, persistence, tests, and documentation.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `2d630270` | (see git log) |
| `138a9ac9` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 14: Phase 3 startup credential readiness

**Date**: 2026-08-30
**Task**: Phase 3 startup credential readiness
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added provider credential readiness to bootstrap, startup, model/session transitions, and turn submission; implemented cancellable TUI login recovery with draft preservation; expanded backend and TUI coverage; documented the runtime contract and user workflow.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `e759ec6d` | (see git log) |
| `52c977f6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 15: Permission and sandbox status UX

**Date**: 2026-08-30
**Task**: Permission and sandbox status UX
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added canonical sandbox readiness inspection, projected effective execution policy consistently through gateway and TUI surfaces, introduced provider-free sandbox status reporting, aligned doctor, and documented the permission/readiness contract.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `77e2748c` | (see git log) |
| `196adb55` | (see git log) |
| `d6312c8b` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 16: Phase 5 settings and command discovery

**Date**: 2026-08-30
**Task**: Phase 5 settings and command discovery
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Implemented the unified settings center, config provenance and single-setting persistence, plus canonical command discovery across the Node gateway and TUI; documented and verified the behavior.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `b8b49589` | (see git log) |
| `c0788749` | (see git log) |
| `e45cc999` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 17: Phase 6 session continuity and recovery

**Date**: 2026-08-30
**Task**: Phase 6 session continuity and recovery
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Unified CLI and TUI session discovery through one backend service, added operational metadata and explicit recovery previews/actions, persisted session permission choices with safe default fallback, documented behavior, and passed the complete repository quality suite.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `b3dabadd` | (see git log) |
| `93bfb3fc` | (see git log) |
| `f2e48cf4` | (see git log) |
| `f45c53b7` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 18: Phase 7 diagnostics and cached updates

**Date**: 2026-08-31
**Task**: Phase 7 diagnostics and cached updates
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added structured recovery diagnostics, provider-free doctor reporting, non-blocking cached update checks, gateway/TUI deduplication, regression coverage, and executable documentation.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0b555204` | feat(diagnostics): add recovery diagnostics and cached updates |
| `62c312bb` | docs(diagnostics): document recovery and update behavior |

### Testing

- [OK] 356 focused Phase 7 contract, config, app/gateway, lifecycle, and TUI tests
- [OK] `npm run lint`, `npm run typecheck`, `npm run contracts:check`, and `npm run build`
- [OK] `npm run smoke:m8` and `npm run smoke:package -- --app-only`
- [NOTE] The full app workspace run retains the pre-existing late Worker-pool RSS/lease timing
  cascade; representative failures pass in isolation and Worker behavior was outside Phase 7.

### Status

[OK] **Completed**

### Next Steps

- Continue the configuration and UX roadmap with the remaining Phase 0-2 gaps and Phase 8.


## Session 19: Codex-style configuration profiles and system layers

**Date**: 2026-08-31
**Task**: Codex-style configuration profiles and system layers
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added launch-scoped profile selection, canonical system/profile configuration layers, deterministic precedence and provenance, session/Worker propagation, validation, tests, and documentation.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `f2a93046` | (see git log) |
| `ea7df894` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 20: UX baseline and contract drift gates

**Date**: 2026-08-31
**Task**: UX baseline and contract drift gates
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added a versioned provider-free UX journey manifest, canonical management help and documentation checks, slash/settings/gateway drift gates, explicit UX and privacy budgets, focused tests, and the long-term maintenance contract.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `2c2b96f2` | (see git log) |
| `70c52d02` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 21: Configuration migration and generated reference

**Date**: 2026-09-01
**Task**: Configuration migration and generated reference
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added provider-free config path and strict validation commands, transactional migration preview/apply/rollback with private backups and optimistic versions, generated configuration references and drift checks, redacted diagnostics, tests, and executable documentation.

### Main Changes

- Added provider-free `config path`, strict validation, and typed text/JSON management responses.
- Added value-free migration preview, expected-version apply, private backups, exact rollback, and
  concurrent-edit protection without reading or writing `auth.json`.
- Generated the Markdown, JSON, and commented TOML references from canonical setting descriptors,
  with a drift gate and executable configuration trust contract.

### Git Commits

| Hash | Message |
|------|---------|
| `336f69c2` | (see git log) |
| `452e06ce` | (see git log) |

### Testing

- [OK] `npm run lint`, `npm run typecheck`, `npm run contracts:check`, `npm run config:check`,
  `npm run test:ux-contracts`, `npm run build`, and `git diff --check`
- [OK] 11 focused config migration/path/reference tests, 63 management/CLI tests, and 5 M7 tests
- [NOTE] The full Node backend integration file retained 9 existing Worker timing failures; a
  representative failing case passed when run alone, and Worker behavior was outside this task.

### Status

[OK] **Completed**

### Next Steps

- Continue the roadmap with unified onboarding and auth management.


## Session 22: Complete unified onboarding and auth management

**Date**: 2026-09-01
**Task**: Complete unified onboarding and auth management
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added provider-free credential commands and rollback-safe setup, unified the first-run TUI journey, enabled transactional trust-driven runtime reloads, stabilized Worker integration tests, and documented the resulting contracts.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `677514f3` | (see git log) |
| `332191e3` | (see git log) |
| `7b89be02` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 23: Complete sandbox setup and recovery UX

**Date**: 2026-09-01
**Task**: Complete sandbox setup and recovery UX
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added typed sandbox status, previewed setup/reset recovery, conservative Windows helper reset, CI coverage, and user-facing recovery documentation.

### Main Changes

- Added typed sandbox readiness and recovery contracts with preview-first setup and reset commands.
- Added conservative Windows helper reset behavior, stable UAC cancellation handling, and CI recovery coverage.
- Documented management commands, platform-specific recovery guidance, and runtime/TUI gateway contracts.

### Git Commits

| Hash | Message |
|------|---------|
| `1ee60271` | feat(sandbox): add typed setup and reset recovery |
| `c92bb13b` | feat(windows): add conservative sandbox state reset |
| `84feeb7d` | docs(sandbox): document setup and recovery contracts |

### Testing

- [OK] `npm run lint`, `npm run typecheck`, `npm run contracts:check`, and `npm run config:check`
- [OK] `npm run build`, `npm test`, and `npm run smoke:package`
- [OK] Local `sandbox status/setup/reset --json` smoke checks
- Windows native helper compilation and primitive tests remain covered by Windows CI.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 24: Complete Doctor repair and support bundle

**Date**: 2026-09-01
**Task**: Complete Doctor repair and support bundle
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Implemented provider-free Doctor repair preview and confirmation, deterministic redacted support bundles, private atomic artifact writes, tests, and public/spec documentation.

### Main Changes

- Added provider-free `doctor --fix` preview and exact-plan confirmation with stale-plan conflict,
  bounded per-action results, and configuration-owner transaction delegation.
- Added deterministic, allowlisted support-bundle export with cross-platform redaction, private
  atomic replacement, stable receipts, and no upload or raw-log collection.
- Hardened the shared private-file writer, added focused and integration coverage, and documented
  the repair, support, and trust contracts.

### Git Commits

| Hash | Message |
|------|---------|
| `75c89e82` | feat(doctor): add safe repair and support bundle |
| `bec86575` | docs(doctor): document repair and support contracts |

### Testing

- [OK] `npm run lint`, `npm run typecheck`, `npm run contracts:check`, and `npm run config:check`
- [OK] `npm run build`, full `npm test`, `npm run test:ux-contracts`, and `npm run smoke:package`
- [OK] App 383/383, TUI 636/636, config 117/117, and focused Doctor 10/10 tests
- [OK] `git diff --check`

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 25: Terminal accessibility and shell completion

**Date**: 2026-09-01
**Task**: Terminal accessibility and shell completion
**Branch**: `feature/mycli-agent-worker-pool`

### Summary

Added layered terminal capability and keymap contracts, semantic accessible TUI rendering, catalog-driven shell completions, non-TTY isolation, regression coverage, and user documentation.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `44a0ff5f` | (see git log) |
| `645a51bb` | (see git log) |
| `70a4166d` | (see git log) |
| `25c5a2f7` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 26: Complete runtime architecture Stage 4

**Date**: 2026-09-04
**Task**: Codex-aligned runtime architecture convergence
**Branch**: `refactor/mycli-runtime-architecture`

### Summary

Completed the transactional repository slice for root-turn terminalization and paired subagent
lifecycle changes while preserving schema v12 and existing gateway payloads.

### Main Changes

- Added one transaction boundary for terminal transcript rows, the durable `turn_lifecycle`
  outbox, `runtime_turns`, and session activity.
- Projected normal runtime terminal events from committed turn/outbox results and durably handled
  rejected Worker provider steps.
- Added one composite repository for paired subagent task/thread transitions, including activation,
  follow-up, terminalization, interruption, and runtime-creation failure.
- Fixed queued cancellation's stale SQL predicate and preserved distinct restart/runtime-owner
  recovery reasons found during final review.
- Added rollback failpoints, committed-result projection tests, and cross-layer regression coverage.

### Testing

- [OK] `npm run lint`, `npm run typecheck`, and `npm run contracts:check`
- [OK] `env TERM=xterm-256color NO_COLOR=1 npm test` (305 test files)
- [OK] Focused storage lifecycle tests and `git diff --check`

### Status

[OK] **Stage 4 completed; overall convergence task remains in progress**

### Next Steps

- Stage 5: immutable effective-policy and tool-catalog snapshots per run.

## Session 27: Complete runtime architecture Stage 5

**Date**: 2026-09-04
**Task**: Codex-aligned runtime architecture convergence
**Branch**: `refactor/mycli-runtime-architecture`

### Summary

Completed immutable per-run collaboration-mode, execution-policy, direct/deferred tool, and skill
catalog snapshots, including durable continuation recovery, compaction accounting, and exact
parent-run inheritance for subagents.

### Main Changes

- Added bounded, fingerprinted, deeply frozen run and tool-catalog snapshots owned by
  `NodeTurnRuntime` from first context preparation through terminal cleanup.
- Kept active runs stable across trust, permission, collaboration-mode, MCP, plugin, and skill
  refreshes while allowing durable `tool_search` activations from only the frozen deferred catalog.
- Persisted snapshots through approval and clarification suspension and restored them with turn-id,
  policy, catalog, and same-process consistency checks before continuation effects.
- Bound restored dynamic routing to exact frozen definitions and made compaction estimate the active
  run's latest activated schema set lazily.
- Changed subagent tool and policy inheritance to resolve the exact parent session/turn snapshot,
  preserving constrained profiles without accidentally promoting trust or consulting global tools.
- Forwarded snapshot lookup through Worker-backed root runtimes and added focused runtime, tools,
  integrations, and backend regression coverage.

### Testing

- [OK] `npm run build`, `npm run lint`, `npm run typecheck`, and `npm run contracts:check`
- [OK] Runtime, tools (248/248), and integrations (109/109) package suites
- [OK] Focused backend Full Access and disabled-parent child-policy integration tests
- [OK] `env -u NO_COLOR TERM=xterm-256color npm test` (306 test files)
- [OK] `git diff --check`

### Status

[OK] **Stage 5 completed; overall convergence task remains in progress**

### Next Steps

- Stage 6: narrow `NodeTurnRuntime` and `node-backend.ts` into composition/orchestration boundaries.
