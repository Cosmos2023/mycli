# Codex-style tool concurrency capabilities

## Goal

Move Node mycli's parallel-execution policy from a backend-maintained tool-name
set into each executable adapter, add conservative MCP read-only/server opt-in,
and make force interruption actively cancel every running adapter while
preserving the existing deterministic phase and replay contract.

## Requirements

- `ToolAdapter` owns an optional parallel capability; absence means sequential.
- `ToolRouter` derives concurrency only from the resolved adapter and no longer
  accepts a parallel tool-name set.
- Built-in `Read`, `web_fetch`, and `tool_search` opt in. Mutations, Shell,
  planning, interaction, polling, and subagent controls remain sequential.
- Extension discovery projects adapter concurrency into the combined manifest
  without trusting provider definitions or origin metadata.
- MCP tools opt in when their standard `annotations.readOnlyHint` is exactly
  `true`, or when their server config explicitly sets
  `supports_parallel_tool_calls=true`; missing and malformed metadata fail
  closed.
- Every active runtime tool call owns a cancellation controller. Force
  interruption aborts the adapter signal and emits one terminal lifecycle.
- A normal failed `ToolExecutionResult` remains isolated from successful
  siblings; unexpected adapter throws remain fatal and cancel the phase.
- Preserve assistant-call-before-execution durability, provider-order result
  persistence, ordered hooks/checkpoints/context, and no late writes.

## Acceptance Criteria

- [x] Router tests prove adapter opt-in and default-false behavior without a
      name-set option.
- [x] Runtime composition no longer constructs or passes `parallelAgentTools`.
- [x] Built-in adapter capability matches manifest metadata for every tool.
- [x] MCP client tests cover read-only hint, missing/malformed annotations, and
      server opt-in.
- [x] MCP registration and combined manifest expose the resolved concurrency
      capability without accepting caller-controlled metadata.
- [x] Two parallel tools may produce one success and one ordinary failed result;
      both persist in provider order and the turn continues.
- [x] `forceInterrupt()` aborts every running adapter signal without requiring
      the submit signal to be aborted separately, with one terminal event per
      call and no late result persistence.
- [x] Lint, all-workspace typecheck, runtime, tools, integrations, app, and TUI
      tests pass.

## Definition of Done

- Focused unit and integration regressions cover capability propagation,
  execution ordering, and interruption.
- Backend concurrency and provider replay specs describe the adapter-owned MCP
  policy and fatal-versus-ordinary failure behavior.
- Existing unrelated TUI and Worker Pool work remains untouched.

## Technical Approach

1. Add an optional immutable concurrency capability to `ToolAdapter` and make
   `ToolRouter` query the resolved route.
2. Mark only the existing three built-in safe adapters and derive extension
   manifest metadata from registered adapters.
3. Normalize MCP annotations/config into `McpToolDescriptor`, then let the MCP
   adapter expose the resolved capability.
4. Give each `ActiveToolExecution` an `AbortController`; compose its signal with
   turn/phase cancellation before invoking the router.
5. Add deterministic runtime and integration tests, then update specs.

## Decision (ADR-lite)

**Context**: The first Node implementation copied manifest names into the app
composition. That is safe but duplicates executable policy and cannot express
MCP read-only/server capability.

**Decision**: Make adapter runtime metadata authoritative while retaining the
explicit provider-order phase scheduler. Do not copy Codex's Shell opt-in or
replace phases with an async read/write lock.

**Consequences**: Extensions can participate conservatively, manifests reflect
actual executable behavior, and interruption becomes cooperative at the exact
call boundary. Static built-in manifests still require an alignment test.

## Out of Scope

- Parallel Shell, WriteStdin, file mutation, planning, clarification, approval,
  or subagent-control tools.
- Replacing explicit phases with Codex's Tokio `RwLock` scheduler.
- Streaming tool execution before the complete assistant call batch is durable.
- Masking unexpected adapter exceptions as ordinary tool failures.
- A user-facing concurrency count setting or Agent Worker Pool work.

## Technical Notes

- Runtime scheduler: `backend/packages/runtime/src/node-turn-runtime.ts`.
- Tool contract/router: `backend/packages/tools/src/types.ts` and `router.ts`.
- Runtime composition: `backend/apps/mycli/src/node-runtime/node-backend.ts`.
- MCP normalization: `backend/packages/integrations/src/mcp/client.ts`,
  `config.ts`, `types.ts`, and `tool-adapter.ts`.
- Existing contracts: `.trellis/spec/backend/tool-manifest-contract.md` and
  `.trellis/spec/backend/provider-tool-replay-contract.md`.
- Research: `research/codex-tool-concurrency.md`.
