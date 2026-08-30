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

(Add details)

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

(Add details)

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

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `7d889886` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: Enable safe parallel tool batches

**Date**: 2026-08-11
**Task**: Enable safe parallel tool batches
**Branch**: `feature/mycli-node-runtime-rewrite`

### Summary

Enabled manifest-gated concurrent execution for safe Node tool phases while preserving provider-order persistence, approvals, hooks, interruption, and sequential barriers.

### Main Changes

(Add details)

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

(Add details)

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

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


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

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
