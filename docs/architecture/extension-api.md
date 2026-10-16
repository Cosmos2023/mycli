# Runtime extension API

Internal features used to be wired as named slots on `NodeTurnRuntimeOptions` (56 fields), so
adding or replacing one meant editing the core turn loop. `@mycli/extensions` replaces that with a
registry: features register contributors, and the runtime asks the registry instead of naming them.

## What exists today

`backend/packages/extensions`:

- `ExtensionRegistry.register(definition)` — registration order is execution order; duplicate or
  empty ids are rejected.
- Slots: `turnLifecycle.onTurnStart` / `onTurnComplete`, `context` (turn-context sections the
  extension renders itself), `conversationItems` (items inserted ahead of the current user input),
  `tokenUsage.onTokenUsage`.
- Isolation: every hook call is wrapped. A throwing extension is reported through `onFailure` and
  never fails a turn, and a throwing `onFailure` cannot break the hook chain either.

The runtime consults the registry in `node-turn-runtime.ts`:

| Slot | Call site |
| --- | --- |
| `onTurnStart` | end of `#prepareTurn`, after admission and before the first provider request |
| `onTokenUsage` | after each provider step reports usage |
| `context` | `#collectExtensionSections`, merged into the durable path's context sources |
| `conversationItems` | `#collectExtensionItems`, inserted before the current input on the direct path |
| `onTurnComplete` | `#completeTurn`, after the terminal snapshot, with `terminalSnapshotWritten` |

Failures land in the session node trace as `extension_failure` rows (extension id, hook, bounded
message), which `/trace` and the doctor support bundle surface.

`memory` is the reference migration: `createMemoryExtension` contributes the section the durable
request path renders and the item the direct path inserts, memoizes one collect per turn, and takes
`terminalSnapshotWritten` instead of the core deciding when durable actions are safe. The core no
longer mentions memory at all.

## What is still missing (goal is the next migration)

Goal still needs the core to know it. The remaining slots, in the order they should land:

### 1. Admission

Goal's idle continuation is the one place a feature decides that a *new turn* should start:

```ts
interface AdmissionContributor {
  nextTurn?(input: { sessionId: string; workspaceRoot: string; activeTurnId?: string }):
    { message: string; source: string; reference?: string } | undefined;
}
```

- Call site: `node-gateway-turn-controller.ts#scheduleNextQueuedTurn`, where
  `runtime.goal?.continuation()` is read today. The proposal must be synchronous: the scheduler is
  synchronous and is called from six places, so an async slot would ripple through all of them.
- Requires `TurnSubmission.source` to stop being the closed union `"user" | "agent_mailbox" |
  "goal"`. Proposed shape: keep the known kinds and add
  `{ kind: "extension"; extensionId: string; reference?: string }`, then let the runtime ask the
  owning extension to validate the reference at `#prepareTurn` (goal does this today through
  `assertContinuation`).
- Acceptance: the goal integration tests (`node-goal.integration.test.ts`) pass with goal's
  continuation coming from the registry, and a second registered extension can be admitted without
  touching the turn controller.

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

## Constraints discovered while migrating memory

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

## Deliberately out of scope

- A general extension *loading* mechanism (plugins that provide runtime contributors). The registry
  is internal for now; external extensibility stays on plugins, skills, hooks, and MCP.
- A per-thread/per-turn extension state bag. Contributors own their state until a slot needs the
  runtime to own it.
- Telemetry parity with Codex (`analytics`/`otel`): goal lifecycle and extension failures go to the
  local node trace only.
