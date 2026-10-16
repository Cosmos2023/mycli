# Runtime extension API

Internal features used to be wired as named slots on `NodeTurnRuntimeOptions` (56 fields), so
adding or replacing one meant editing the core turn loop. `@mycli/extensions` replaces that with a
registry: features register contributors, and the runtime asks the registry instead of naming them.

## What exists today

`backend/packages/extensions`:

- `ExtensionRegistry.register(definition)` — registration order is execution order; duplicate or
  empty ids are rejected.
- Slots: `admission` (`nextTurn` / `assertAdmission` / `onAdmissionFailed`),
  `turnPolicy` (`stopReason` / `toolsStopReason` / `allowTools`),
  `sessionLifecycle` (`onRestore` / `onInterrupt` / `onClose`), `tools`,
  `compactionBudget` (the account a compaction summary is charged to),
  `conversationContext` (who fills the session's `conversation_context` fragment),
  `delegation` (carrying an extension's accounting across a runtime boundary),
  `failure` (an extension classifying the errors it raised),
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
| `stopReason` | `#turnStopFailure`, before each provider step |
| `toolsStopReason` | `#turnStopFailure` and the `ToolBatchCoordinator` tool-stop callback |
| `allowTools` | the wrap-up step that decides whether the request carries tools |
| `onRestore` / `onInterrupt` / `onClose` | the app's session activation, interruption, and close paths |
| `tools` | `node-backend.ts`, when the static tool catalog is built |
| `compactionBudget` | `node-backend.ts`, once per compaction before the summarizer runs |
| `conversationContext` | `mergeRuntimeContextSources`, when the app leaves the field empty |
| `captureDelegatedWork` / `bindDelegatedWork` / `releaseDelegatedWork` | the agent-thread factory that runs delegated work |
| `normalizeFailure` | `#normalizeFailure`, before the runtime's own failure rules |

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

### Turn policy (done)

Goal decides when a turn stops and whether the wrap-up step may use tools. That decision now comes
from `turnPolicy.stopReason` / `toolsStopReason` / `allowTools`, and `node-turn-runtime.ts` no
longer mentions goal at the five call sites that used to read it (two `ToolBatchCoordinator`
callbacks, the post-step stop check, the tool-stop check, and the wrap-up step that used to call
`goal.beginWrapUpStep`).

- `stopReason` / `toolsStopReason` are synchronous reads; the first contributor with a stop wins.
  A throwing contributor cannot decide, so it is reported and skipped — the failure stays visible
  in the session trace.
- `allowTools` asks **every** contributor and one `false` strips tools, so an extension's internal
  state never depends on whether another extension short-circuited the loop. That is what keeps
  goal's one-shot wrap-up step advancing on every step.
- `ExtensionTurnStop.interruptionReason` is a plain string on the boundary and the runtime
  validates it with `isTurnInterruptionReason`, so the extensions package does not need a second
  workspace dependency.
- `createGoalUsageExtension` is the delegated-work half: a subagent runtime carries no goal service
  of its own, so it mirrors the parent goal it was bound to.

### Usage accounting (done)

`NodeTurnRuntimeOptions.goal` and `.goalUsage` are gone: the runtime no longer imports
`SessionGoalService` at all. The `tokenUsage` slot now carries every observation once, tagged with
`phase: "attempt" | "final"` and, for attempts, the retry index.

- A retry attempt reports what it spent as soon as the provider streams usage, because an attempt
  that fails still costs tokens.
- A step reports its settled usage under `${usageId}:final` **only when no attempt reported any**,
  which is what keeps goal accounting from counting one step twice (`session_goal_usage` is keyed
  by request id). The `phase` field makes that rule visible instead of implicit.
- A response that produced events but no usage reports an empty usage, so the cost is recorded as
  unknown rather than free; goal turns that into `usage_incomplete` and stops a budgeted goal.
- `createGoalExtension` and `createGoalUsageExtension` both implement `onTokenUsage`, and the
  runtime wires `recordUsage` whenever a registry exists instead of whenever goal exists.

### Tools and session lifecycle (done)

- `tools` lets an extension contribute `ToolAdapter`s to the session's static catalog, so the app
  no longer names `GoalTool`. A throwing contributor is reported and skipped — a broken extension
  must not leave the session without a catalog.
- `sessionLifecycle` carries `onRestore` / `onInterrupt` / `onClose`. `restore` and `interrupt` are
  contract-bearing (they decide whether a feature may keep driving work), so they report and
  propagate; `close` releases resources, so every extension is closed and the first failure is
  rethrown afterwards.
- The registry is now created right after the goal service, before the tool catalog is built, and
  the memory extension is registered later when its service exists. The app composes goal through
  the registry for admission, turn policy, usage, tools, and session lifecycle.

### Compaction budget (done)

Compaction no longer names goal. `compactionBudget` resolves the account a summary is charged to
**once per compaction** and hands back a handle:

```ts
interface ExtensionCompactionBudget {
  remainingTokenBudget(): number | undefined;   // read fresh: the attempt itself can consume it
  observeUsage(requestId: string, usage: ProviderUsage): void;
}
```

Resolving once is what preserves the old behaviour: the app used to capture the charged goal id
before the summarizer ran, so a goal that flipped to `budget_limited` mid-compaction kept being
charged and kept limiting output. The remaining amount is still read fresh on every check, because
the summarizer deliberately re-reads it at dispatch ("attempt persistence can change ownership or
consume Goal budget"). `createGoalExtension` charges the goal accounting for the turn, or the
active goal when compaction runs outside a turn; `createGoalUsageExtension` charges the parent goal
a child turn was bound to.

### Goal context (done)

`sessionGoalContext` no longer appears in the app. The `conversationContext` slot decides who fills
the session's `conversation_context` fragment, and `createGoalExtension` fills it with the goal's
model view plus any steering for the running turn.

This deliberately stays a **separate field** rather than becoming an extension `context` section.
`conversation_context` is a contract fragment kind with its own position in the instruction list
(between `environment_context` and `compaction_rehydration`), and extension sections render after
`compaction_rehydration`. Moving goal into the section list would reorder the model input and move
the prefix-cache boundary for no behavioural gain. The slot therefore answers "who fills this
fragment", not "what does it render as". The app still wins when it sets the field itself.

### Delegation (done)

`runtime.goalUsage.capture` / `.bind` / `.release` are gone from the app; the gateway runtime view
no longer carries `goalUsage` at all. `delegation` moves an extension's accounting across a runtime
boundary: the parent runtime's registry captures handles for the turn that delegated work, and the
child runtime's registry offers each handle to every extension that can adopt one.

Two details are deliberate:

- **Handles are not keyed by extension id.** The capturer and the adopter are different extensions
  in different registries (`goal` captures on the parent side, `goal-usage` adopts on the child
  side), so keying on an id silently dropped every handle. Each handle is broadcast instead, and an
  extension ignores the ones it does not recognise — adopting an unknown handle must not clear a
  binding it already holds.
- **Handles are opaque.** `goal` captures the `{ service, ref }` binding, and `goal-usage`
  re-validates the shape before handing it to the tracker.

### Failure classification (done)

`node-turn-runtime.ts` no longer mentions goal anywhere. The `failure` slot lets an extension
classify an error it raised, so a feature's own failure keeps its meaning instead of becoming an
internal error: `goal` maps `GoalStateError` to `interrupted` with the error's own message, exactly
as the runtime's hard-coded branch did.

The slot is consulted **before** the runtime's own rules, matching where that branch sat. The cost
was mechanical rather than conceptual — the classifier has to be reachable from the free
`normalizeFailure` helper, so the ~20 call sites became `this.#normalizeFailure(...)`, which tries
the registry first and otherwise delegates to the unchanged helper.

## What is still missing

`node-turn-runtime.ts` no longer names any feature: memory and goal are both composed entirely
through the registry. What is left is one durable-format decision.

**`TurnSubmission.source`** is still the closed union `"user" | "agent_mailbox" | "goal"` because
storage persists it and the transcript renders it (`payload.source === "goal"` becomes "Continuing
goal", and schema v15 gates goal input). Generalising it to `{ kind: "extension", ... }` means a
storage migration plus a projection change, so an extension that is not goal cannot yet admit a
turn with its own durable label — it would have to borrow `"goal"`. That is the last thing standing
between the registry and a second feature that admits turns.

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
