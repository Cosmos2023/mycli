# Assertion Audit Round 2 (2026-09-18)

Round 2 covers the backend specs that round 1 did not touch and closes the
round-1 rows whose evidence was weak by running the canonical suites.

## Scope And Method

Specs reviewed: every `.trellis/spec/backend/*.md` file except the five from
round 1. Empirical claims were extracted with the same pattern as round 1
(`proves|proven|verified|has passed|zero skips|all N|N/N pass`). The four files
that carry such claims are `runtime-tui-gateway-contract.md`,
`provider-tool-replay-contract.md`, `database-guidelines.md` and
`context-management-contract.md`. The remaining specs are normative contracts
without numeric or verification claims; their checkable surface is the test suite.

## Canonical Gate Evidence

| Check | Result | Artifact |
| --- | --- | --- |
| Test catalog integrity | 472 files classified exactly once: unit 372, contract 31, integration 56, platform 11, release 2 | `build/r2-test-list.json` |
| Canonical unit suite | 372 files pass in 270.8s, started from a `TERM=dumb` parent | `build/r2-unit-pinned.log` |
| Canonical contract suite | 31 files pass in 14.4s | `build/r2-contract.log` |
| Canonical integration suite | 56 files pass in 554.8s | `build/r2-integration.log` |

## Claim Mapping

Reclassification: the provider-tool-replay and context-management bullets live in
`### 6. Tests Required` sections, so they are test *requirements*, not claims that
verification already happened. The audit therefore checks whether the required test
exists rather than whether a claimed result is reproducible.

| Required test or claim | Location | Status | Exact artifact |
| --- | --- | --- | --- |
| Post-completion disconnect proves no request is replayed | provider-tool-replay-contract §3 | exists | `runtime/test/errors/error-boundaries.integration.test.ts` — "disconnect after terminal commit preserves the result without replay" |
| Two safe calls both start before either is released | provider-tool-replay-contract §6 | exists | `runtime/test/turns/node-turn-runtime.test.ts` — "executes safe tool phases concurrently and preserves provider result order around barriers" (`waitForStarted(2)`, one release, zero results) |
| Two allowed Shell commands overlap with per-call sandbox authorization | provider-tool-replay-contract §6 | exists | `runtime/test/turns/node-turn-runtime.test.ts` — "executes allowed Shell calls concurrently with per-call sandbox authorization" |
| Safe-safe-sequential-safe batch proves phase barriers and start ordering | provider-tool-replay-contract §6 | exists | Same test as above; the scripted batch is Read, Read, Write, Read with start-order assertions |
| Bounded call-id collision retains both raw ids | provider-tool-replay-contract §6 | exists | `runtime/test/turns/node-turn-runtime.test.ts` — "tracks parallel calls by their full ids when bounded event ids collide" |
| Post-output disconnect retries the same frozen request and discards the incomplete attempt | provider-tool-replay-contract §3 | not exact-mapped | Stream-recovery tests exist in `provider-attempt-recovery.test.ts` and `worker-provider-step-executor.test.ts`; no case name matches the requirement |
| Mock Node agent smoke: DeepSeek Chat child completes its first provider turn and tool call through the worker runtime | context-management-contract §6 | partial | Mock child-through-worker coverage exists in `apps/mycli/test/node-backend.integration.test.ts` ("Node backend runs a spawned subagent with in-process root and Worker subagent"); the credential-gated live smoke `scripts/smoke_node_agents.mjs` supports `--protocol chat_completions --subagent-adapter worker`. No mock DeepSeek-Chat-specific smoke was located |
| Exactly one relational row points to verified content | database-guidelines | family-located | `storage/test/artifacts/session-content-blob-schema.test.ts`, `session-content-blob-repository.test.ts` |
| Queue RPC ACK persistence, effect outcomes, blob GC proofs, incremental tail rendering | runtime-tui-gateway-contract | sample-verified | TUI and runtime families carrying these cases pass inside the 372-file unit run |

## Findings Fixed In This Round

1. **TUI tests were coupled to the ambient terminal.** Running the canonical unit
   suite from a `TERM=dumb` shell failed nine assertions across the transcript,
   selector and web-search fixtures because `uiGlyphs()` falls back to ASCII unless
   `TERM` is a real terminal. `scripts/run-test-suite.mjs` now pins
   `TERM=xterm-256color` and `MYCLI_TUI_ASCII=0` unless the caller sets them,
   matching the documented fixture convention. Before: `build/r2-unit.log`
   (9 failures). After: `build/r2-unit-pinned.log` (372 files pass).
2. **The unit gate flaked under default parallelism.** Three consecutive runs failed
   three different tests: two variants of `worker-leased-agent-runtime.test.ts` and
   the `transcript-separator` divider test. Each passed in isolation (the worker file
   is 8/8 on its own). The runtime and tui targets now pin `testConcurrency: 4`, and
   the worker lease helper's `waitFor` default moved from 2s to 10s. Evidence of the
   failures: `build/r2-unit.log`, `build/r2-unit-utf8.log`, `build/r2-unit-final.log`.
3. **Catalog integrity holds.** 472 discovered files map to exactly one suite; the
   catalog rejects duplicates and stale overrides by construction.

## Remaining Open Items

- One provider-replay requirement ("post-output disconnect retries the same frozen
  request") still has no exact case mapping, and the DeepSeek-Chat mock smoke exists
  only as generic mock child coverage plus a credential-gated live smoke.
- Round 2 did not attempt the elevated WFP ingress diagnosis; that remains blocked on
  administrator access, as recorded in round 1.
