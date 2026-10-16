# Runtime extension API

Internal features used to be wired as named slots on `NodeTurnRuntimeOptions` (56 fields), so
adding or replacing one meant editing the core turn loop. `@mycli/extensions` replaces that with a
registry: features register contributors, and the runtime asks the registry instead of naming them.

## What exists today

`backend/packages/extensions`:

- `ExtensionRegistry.register(definition)` — registration order is execution order; duplicate or
  empty ids are rejected.
- Slots: `admission` (`nextTurn` / `assertAdmission` / `onAdmissionFailed`),
  `turnLifecycle` (`onTurnAdmitted` / `onTurnStart` / `onTurnComplete` / `onTurnFinished`),
  `context` (turn-context sections the extension renders itself), `conversationItems` (items
  inserted ahead of the current user input), `tokenUsage.onTokenUsage`.
- Isolation: every hook call is wrapped. A throwing extension is reported through `onFailure` and
  never fails a turn, and a throwing `onFailure` cannot break the hook chain either.

The runtime consults the registry in `node-turn-runtime.ts`:

| Slot | Call site |
| --- | --- |
| `onTurnAdmitted` | `submit`, right after reservation and before `#prepareTurn` |
| `onTurnStart` | end of `#prepareTurn`, after admission and before the first provider request |
| `onTokenUsage` | after each provider step reports usage |
| `context` | `#collectExtensionSections`, merged into the durable path's context sources |
| `conversationItems` | `#collectExtensionItems`, inserted before the current input on the direct path |
| `onTurnComplete` | `#completeTurn`, after the terminal snapshot, with `terminalSnapshotWritten` |
| `onTurnFinished` | `#finishTurn`, after the turn record reached a terminal status |
| `nextTurn` | `node-gateway-turn-controller.ts#scheduleNextQueuedTurn`, when the session is idle |
| `assertAdmission` | `NodeTurnRuntime.reserve`, before the turn is persisted |
| `onAdmissionFailed` | the turn controller's `startFailed` path |

Failures land in the session node trace as `extension_failure` rows (extension id, hook, bounded
message), which `/trace` and the doctor support bundle surface.

`memory` is the reference migration: `createMemoryExtension` contributes the section the durable
request path renders and the item the direct path inserts, memoizes one collect per turn, and takes
`terminalSnapshotWritten` instead of the core deciding when durable actions are safe. The core no
longer mentions memory at all.

### Admission (done)

`createGoalExtension` is the reference migration for admission. It decides when an idle session
continues its objective, validates the reference before the turn is reserved, and tracks every turn
through `onTurnAdmitted` / `onTurnFinished`.

- `nextTurn` is synchronous by contract: the scheduler is synchronous and is called from six
  places, so an async slot would ripple through all of them. A throwing `nextTurn` is reported and
  treated as "no turn", so a broken extension cannot stall the scheduler for the others.
- `assertAdmission` / `onAdmissionFailed` are dispatched only to the extension that issued the
  admission and are **contract-bearing**: the error is reported *and* propagated, because the
  validation gates whether the turn starts at all.
- `TurnSubmission.goalRef` became `TurnSubmission.admission: { extensionId, reference? }`, so the
  runtime no longer imports `GoalRef`. The reference is opaque to the runtime — goal puts the goal
  reference itself there and the registry hands it back unchanged. It is never persisted.
- `TurnSubmission.source` stays the closed union `"user" | "agent_mailbox" | "goal"` because
  storage persists it and the transcript renders it (`payload.source === "goal"` becomes
  "Continuing goal", and schema v15 gates goal input). Generalising it to
  `{ kind: "extension", ... }` needs storage work and was deliberately left out of this slice.

## What is still missing

### 2. Turn policy

Goal decides when a turn stops and whether the wrap-up step may use tools:

```ts
interface TurnPolicyContributor {
  stopReason?(input: { sessionId: string; turnId: string }): RuntimeFailure | undefined;
  toolsStopReason?(input: { sessionId: string; turnId: string }): RuntimeFailure | undefined;
  allowTools?(input: { sessionId: string; turnId: string }): boolean;
}
```

- Call sites: `node-turn-runtime.ts` — the post-step stop check, the tool-stop failure, and the
  wrap-up step that currently strips tools through `goal.beginWrapUpStep(turnId)`.
- Acceptance: goal's budget/blocked/paused stop paths keep their current messages and interruption
  reasons, verified by `node-goal.integration.test.ts` and the goal service tests.

### 3. Tools and session lifecycle

- Tool registration: goal exposes `create_goal`, `get_goal`, and `update_goal` from the app's tool
  exposure today (`runtimeToolExposure` in `node-backend.ts`). The slot should let an extension
  contribute tool definitions plus adapters, so the catalog is built from the registry.
- Session lifecycle: `restore()`, `interrupt()`, `close()`, and `subscribe()` are driven by the app
  (`node-gateway-session-controller.ts`, `node-backend.ts`). A `sessionLifecycle` slot should carry
  those so a feature can react to cold activation and interruption without the app naming it.

## Constraints discovered while migrating

1. **Context sections must be merged after the app's `contextSources` callback.** The callback
   returns its own object, so sections passed only as callback *input* are dropped silently. The M5
   integration test caught exactly that.
2. **The app must not declare `@mycli/*` packages in its `package.json`.** The release validator
   rejects it (`release_app_vendored_dependency_exposed`); workspace hoisting resolves the import.
3. **A new workspace package needs three registrations**: the root `build` script, the
   `scripts/test-suite-catalog.mjs` test target, and `scripts/release-config.mjs`'s vendored list
   (which the release-scripts test counts).
4. **Scripts that construct the runtime directly must move too** — `scripts/smoke_node_m5_state.mjs`
   built a registry by hand after the memory migration.
5. **`#finishTurn` stays synchronous.** It calls `runTurnFinished` without awaiting it: the
   registry runs each hook up to its first `await` before yielding, so a synchronous owner (goal)
   has already updated its state when the next scheduler pass reads it, and the registry never
   rejects, so there is no unhandled rejection to guard.
6. **Goal's per-turn bookkeeping is a lifecycle hook, not an admission hook.** `beginTurn` runs for
   *every* turn (goal attributes usage on human turns too), so it lives on
   `turnLifecycle.onTurnAdmitted` rather than on the admission contributor, which is dispatched to
   the owning extension only.

## Deliberately out of scope

- A general extension *loading* mechanism (plugins that provide runtime contributors). The registry
  is internal for now; external extensibility stays on plugins, skills, hooks, and MCP.
- A per-thread/per-turn extension state bag. Contributors own their state until a slot needs the
  runtime to own it.
- Telemetry parity with Codex (`analytics`/`otel`): goal lifecycle and extension failures go to the
  local node trace only.
