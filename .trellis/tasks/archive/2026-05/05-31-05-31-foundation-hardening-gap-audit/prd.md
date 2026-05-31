# Hermes-like Foundation Hardening

## Problem

`mycli` has a working runtime and Node TUI skeleton, but the foundation is not
yet mature enough to serve as a stable local coding agent base. The goal is to
harden the integration branch from "runtime/TUI skeleton" into a system with
durable session state, a stable runtime event contract, observable tool and
approval flows, actionable diagnostics, and a repeatably verified Node TUI
gateway.

Hermes-agent is the semantic and product-maturity reference. This task must not
copy Hermes code.

## Scope

Baseline branch: `feature/mycli-hermes-parity-integration`

Work branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main` unless the user explicitly
asks to merge.

Included foundation tracks:

1. Session / State parity
2. Runtime event contract parity
3. Tool / approval / safety foundation
4. Diagnostics / logs / trace / doctor parity
5. Node TUI gateway foundation

Excluded from productization in this goal:

- MCP
- skills
- subagent / multi-agent
- ACP

Small mocks or stubs are allowed only when they verify foundation interfaces.

## Current Slice

This Trellis task owns the first foundation hardening slice:

1. Produce a gap matrix comparing Hermes reference behavior with current
   `mycli` integration-branch behavior.
2. Make Node TUI dependency installation, tests, and typecheck repeatable or
   clearly actionable when the local environment interrupts installation.

This slice is intentionally not an audit-only task. The first executable output
is a repeatable Node TUI verification path because every later TUI contract
change depends on it.

## Requirements

### A. Gap Matrix

- Document current parity across the five foundation tracks.
- For each gap, record risk, first hardening action, and verification command.
- Use Hermes only as reference semantics, not as copied implementation.

### B. Node TUI Dependency Verification

- `npm --prefix tui/node ci` must either complete successfully or leave an
  actionable diagnostic that explains incomplete installs.
- `npm --prefix tui/node run verify:deps` must detect partial installs and tell
  the user how to recover.
- Verification must not silently pass when only part of `node_modules` exists.
- Diagnostics should mention the expected clean-install command and the partial
  install cleanup command.

### C. Node TUI Test And Typecheck Gate

- After dependencies are present, these commands should be repeatable:
  - `npm --prefix tui/node test`
  - `npm --prefix tui/node run typecheck`
- If a local environment issue prevents completion, record the exact command,
  observed output, and next recovery step in the check artifact.

### D. Architecture Boundaries

- Domain stays independent of infrastructure.
- Application code orchestrates runtime behavior.
- Services own cross-cutting diagnostics/logging/tracing.
- CLI gateway code remains a boundary adapter.
- TypeScript protocol/reducer changes must stay aligned with Python gateway
  contract docs.

## Acceptance Criteria

- `research/foundation-gap-matrix.md` exists and covers all five foundation
  tracks.
- `implement.jsonl` and `check.jsonl` contain real spec/research context, not
  only the seeded example row.
- Node TUI dependency verification covers at least:
  - clean missing install
  - partial interrupted install
  - required binary/package presence
- The local run records evidence for:
  - `npm --prefix tui/node ci`
  - `npm --prefix tui/node run verify:deps`
  - `npm --prefix tui/node test`
  - `npm --prefix tui/node run typecheck`
- Python tests relevant to changed files pass.
- The task is archived after implementation and verification.

## Later Foundation Slices

The next slices should be created as separate Trellis tasks after this one:

1. Runtime contract/schema convergence: Python gateway, TypeScript protocol,
   reducer, manifest, and spec alignment.
2. Session/state recovery hardening: root-to-tip resume, waiting state
   persistence, orphan cleanup, and doctor checks.
3. Diagnostics/logs/trace/doctor hardening: redaction, trace corruption,
   runtime manifest, provider/config checks.
4. Tool/approval/safety hardening: tool id stability, approval modes,
   cancellation/interruption, long-output linkage, and trace correlation.

## Non-goals

- No merge to `main`.
- No unrelated directory refactor.
- No Hermes code copy.
- No MCP/skills/subagent/ACP productization.
- No audit-only completion unless executable verification is blocked by an
  external condition and the blocker is reproduced with evidence.
