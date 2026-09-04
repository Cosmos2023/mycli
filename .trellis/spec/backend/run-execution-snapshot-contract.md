# Run Execution Snapshot Contract

> Immutable per-run authority and provider-surface ownership across runtime, tools, continuations,
> compaction, and subagents.

## Scenario: Freeze Effective Policy And Tool Catalog Per Run

### 1. Scope / Trigger

- Trigger: changing turn preparation, collaboration-mode selection, execution policy, direct or
  deferred tool exposure, `tool_search`, extension refresh, approval/clarification continuation,
  compaction budgeting, Worker root wrappers, or subagent spawn inheritance.
- `RunExecutionCoordinator`, composed by `NodeTurnRuntime`, owns one run snapshot from the first
  execution-context preparation until the turn becomes terminal. Configuration and extension
  services remain authorities for the next run, not mutable inputs to an already active run.

### 2. Signatures

- Snapshot construction:
  `createRunExecutionSnapshot(input) -> RunExecutionSnapshot`.
- Durable restoration:
  `parseRunExecutionSnapshot(value, expectedTurnId?) -> RunExecutionSnapshot`.
- Provider exposure:
  `toolExposureForSnapshot(catalog, activatedToolNames) -> ToolDefinition[]`.
- Runtime lookup:
  `NodeTurnRuntime.runExecutionSnapshot(turnId) -> RunExecutionSnapshot | undefined`.
- Policy restoration:
  `ExecutionPolicyCoordinator.restoreTurn(turnId, policy) -> TurnExecutionPolicy`.
- Tool route binding:
  `ToolRouter.beginTurn(turnId, catalog?) -> void` and
  `ToolAdapter.beginTurn?(turnId, catalog?) -> void`.
- Durable suspension field:
  `suspended_turn.payload.continuation.run_snapshot`.
- Compaction factory:
  `createCompactionCoordinator(config, runSnapshot?) -> CompactionCoordinatorContract`.
- Child inheritance callback:
  `parentTools({parentSessionId, parentTurnId}) -> string[]`.

### 3. Contracts

- A new run snapshot contains its `turnId`, frozen collaboration mode, optional effective execution
  policy, and one tool catalog. The catalog contains its source version, direct definitions,
  deferred definitions, optional rendered skill catalog, and a deterministic SHA-256 fingerprint.
- Snapshot construction validates and copies all nested values. Callers cannot mutate policy roots,
  tool arrays, definitions, schemas, or skill text after the snapshot is created.
- The first provider step and every later step in the run use the same collaboration mode, direct
  catalog, deferred catalog, and skill catalog. Trust, permission, MCP, plugin, or skill discovery
  changes affect only a later run.
- Durable `tool_activation` effects may expose additional schemas during a run, but only by selecting
  names from that run's frozen deferred catalog. Unknown, removed, newly discovered, or duplicate
  names do not widen exposure. Schema additions invalidate Responses continuation before canonical
  replay.
- `ToolRouter` binds a restored dynamic route only when both its route name and complete current
  definition match the frozen deferred definition. A refreshed adapter with a different schema is
  unavailable to the old run even if it reuses the same name.
- Approval and clarification suspension persist the complete run snapshot with the continuation.
  Restoration requires the suspended turn id to match. When the same process still owns the run,
  the durable snapshot must equal the active snapshot exactly before any resolution side effect.
- A restored execution policy becomes the policy coordinator's base for that turn instead of being
  recomputed from current settings. A user-approved temporary permission grant creates a new
  immutable policy snapshot for the same run; it does not change the frozen collaboration mode or
  tool catalog.
- Compaction resolves its base context lazily on every attempt. For an active run, it counts the
  frozen direct catalog plus only that run's latest durable deferred activations, so an activation
  cannot leave the next provider request outside the local context estimate.
- A child agent inherits its parent tools and execution policy from the exact parent session/turn
  snapshot. Child-requested tools can narrow that set but cannot expand it. Missing parent snapshot
  state fails closed to an empty tool set and a read-only policy projection instead of consulting the
  current global catalog or policy.
- Root Worker wrappers forward snapshot lookup without owning a second copy. Terminal cleanup asks
  `RunExecutionCoordinator` to end policy state and remove the in-memory mode/snapshot state
  together.
- Catalogs contain at most 512 total direct and deferred definitions. Each input schema is at most
  512 KiB, the complete catalog is at most 2 MiB, the complete run snapshot is at most 3 MiB, and
  identifiers, roots, domains, descriptions, and skill text retain their local bounds.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Snapshot version is unsupported | Reject before context or tool restoration |
| Restored `turnId` differs from the suspended turn | Reject the continuation |
| Catalog fingerprint differs from its definitions or skill catalog | Reject the snapshot |
| Duplicate tool id/name or more than 512 definitions | Reject snapshot construction/restoration |
| Schema, catalog, or run payload exceeds its limit | Reject before retaining or executing it |
| Policy mode and filesystem disagree | Reject the snapshot |
| Read-only policy has writable roots | Reject the snapshot |
| Workspace-write policy has no writable root | Reject the snapshot |
| Root is relative, non-normalized, or duplicated | Reject the snapshot |
| Trust configuration and `toolsEnabled` disagree | Reject the snapshot |
| Durable snapshot differs from an active same-process snapshot | Reject before approval/clarification resolution |
| Activated name is absent from the frozen deferred catalog | Ignore it; do not expose or route the tool |
| Current dynamic adapter definition differs from the frozen definition | Keep the route unavailable for that run |
| Parent run snapshot is unavailable | Spawn inherits no tools and no elevated authority |

### 5. Good/Base/Bad Cases

- Good: MCP refresh replaces `docs_old` with `docs_new` while a run is active; the active run can
  still expose only `docs_old`, and the next run sees only `docs_new`.
- Good: an approval survives restart with its Plan-mode instruction, trusted workspace policy,
  deferred catalog, activated tools, and skill catalog intact.
- Good: an untrusted parent with a constrained workspace profile gives the child the same filesystem
  shape while preserving `trusted=false` and disabling process-tool exposure.
- Base: a run without an execution-policy coordinator still receives a frozen mode and tool catalog.
- Bad: rebuild provider tools from the latest extension registry on every provider step.
- Bad: restore only the tool call and recompute mode or policy from current session settings.
- Bad: let a child resolve parent authority from `allToolExposure` or the current global policy.

### 6. Tests Required

- Snapshot unit tests assert deep immutability, fingerprint validation, turn identity, policy
  consistency, duplicate rejection, and byte/count limits.
- Runtime tests change mode, trust, direct/deferred definitions, and skill catalog between provider
  steps and assert the active run is unchanged while the next run observes the refresh.
- Approval and clarification tests recreate continuation coordinators and recover the exact stored
  snapshot; same-process mismatch tests assert resolution has not started.
- Router and `tool_search` tests restore an old catalog after dynamic refresh and assert newly added
  or schema-changed routes cannot be discovered or executed.
- Compaction tests change durable activations between estimates and assert the lazy base-context
  token count changes without consulting a refreshed global catalog.
- Subagent controller and backend integration tests assert exact parent session/turn lookup, tool
  narrowing, Full Access inheritance, and disabled-trust preservation.
- Run lint, type-check, build, contract drift, focused runtime/tools/integrations tests, the complete
  repository suite, and `git diff --check` because this boundary spans four packages and the app.

### 7. Wrong vs Correct

#### Wrong

```typescript
const tools = currentToolCatalog();
const policy = executionPolicyCoordinator.snapshot().profile;
await resumeApproval({ tools, policy });
```

This silently changes the suspended run when settings or integrations refresh.

#### Correct

```typescript
const snapshot = parseRunExecutionSnapshot(
	pending.runSnapshot,
	pending.turnId,
);
toolRouter.beginTurn(pending.turnId, snapshot.toolCatalog);
if (snapshot.policy) {
	executionPolicyCoordinator.restoreTurn(pending.turnId, snapshot.policy);
}
```

The continuation resumes the authority and provider surface that originally suspended it.
