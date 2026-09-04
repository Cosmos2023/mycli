# Stage 6 Responsibility Audit

## Scope

Stage 6 narrows these two live composition boundaries without changing Gateway RPC, SQLite schema,
provider behavior, tool semantics, or TUI events:

- `backend/packages/runtime/src/node-turn-runtime.ts`
- `backend/apps/mycli/src/node-runtime/node-backend.ts`

The audit compares their current responsibilities with the Codex split between session state,
turn execution, tool orchestration, task lifecycle, and composition services.

## NodeTurnRuntime Findings

Before Stage 6, `NodeTurnRuntime` was both an orchestrator and the mutable owner of independent
subsystems:

| Responsibility | Before Stage 6 | Stage 6 owner |
| --- | --- | --- |
| Per-run mode, policy, and frozen tool catalog | Maps and configuration fields on the runtime | `RunExecutionCoordinator` |
| Agent step/tool/token/wall-clock budgets | Mutable counters on the runtime | `AgentBudgetTracker` |
| Active tool claims, abort signals, terminal events, and diagnostics | Nested maps on the runtime | `ActiveToolExecutionRegistry` |
| Provider-order tool phases, approval/hook barriers, execution, and result application | Nested methods on the runtime | `ToolBatchCoordinator` |

The provider loop, continuation sequencing, compaction sequencing, and calls into durable
terminalization remain in `NodeTurnRuntime`. Those are orchestration duties. SQLite remains the
terminal turn authority, continuation coordinators remain the suspension authority, and the tool
router remains the adapter authority.

## Node Backend Findings

Before Stage 6, `startNodeBackend()` owned mutable registries and shutdown state in addition to
composing dependencies:

| Responsibility | Before Stage 6 | Stage 6 owner |
| --- | --- | --- |
| Session-to-runtime lookup and extension refresh fanout | Mutable `Map` closure | `NodeRuntimeRegistry` |
| Ordered, idempotent resource shutdown | Duplicated nested `try/finally` trees | `NodeBackendResourceOwner` |
| Serialized derived-artifact writes | Local promise-chain class | `SerializedSessionArtifactQueue` |
| Trace serialization and redaction | Large helper cluster in composition file | `node-runtime-trace.ts` |
| Session recovery and readable artifact projection | Large helper clusters in composition file | Focused bootstrap/projection modules |

The backend continues to choose concrete providers, stores, tools, integrations, workers, and the
Gateway. It does not gain a second lifecycle state machine, durable queue, or run snapshot.

## Preserved Boundaries

- The exact run snapshot remains stable from first preparation through terminal cleanup.
- Tool calls and results remain persisted in provider order.
- Active tool interruption still emits one terminal event per started call.
- A stale claim cannot release or terminalize replacement work.
- Resource shutdown aborts producers before draining projections and closing SQLite.
- Session recovery continues to rebuild derived artifacts from canonical SQLite rows.
- Worker wrappers forward runtime operations and do not copy runtime ownership state.

## Verification

- Add transition tests for each extracted mutable owner.
- Retain the existing runtime batch, continuation, interruption, snapshot, and terminalization tests.
- Retain the existing backend startup, session exclusivity, Worker, recovery, and close-drain tests.
- Run build, lint, typecheck, contract drift, focused package tests, full repository tests, and
  `git diff --check`.

Completed evidence:

- Extracted-owner tests: 14/14 passed.
- Runtime package: 430/430 passed, including provider-order parallel phases, approval and
  clarification barriers, exact interruption, snapshot restoration, and terminalization.
- Backend integration: 54/54 passed after the final session, trace, resource, and tool-batch split.
- Repository suite: 310/310 test files passed across unit, contract, integration, platform, and
  release suites.
- Build, lint, typecheck, contracts/config drift, and `git diff --check` passed.
