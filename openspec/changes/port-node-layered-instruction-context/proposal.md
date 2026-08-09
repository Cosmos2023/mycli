## Why

The Node.js runtime currently sends a one-line base prompt and assembles memory or other context directly in memory before provider requests. It therefore cannot match the Python runtime's layered instruction behavior or prove that every model-visible input was durably recorded before it entered a provider context window.

## What Changes

- Add a Node-native layered instruction contract separating stable base instructions, developer policy, contextual user fragments, canonical conversation, and the current user request.
- Ship the complete mycli system prompt in the Node application and freeze it per session through a versioned instruction snapshot.
- Discover and safely load workspace instructions such as `AGENTS.md`, expose the skill catalog, and inject collaboration mode, execution policy, tool exposure, hook context, memory, and compaction context with explicit roles and cache classes.
- Add an append-only model-input ledger for immutable context events, instruction snapshots, tool-set snapshots, and per-provider-step request manifests.
- Enforce persist-before-send: a provider request is not dispatched unless its complete model-visible input and exact ordering have been committed successfully.
- Represent context changes, removals, continuation resets, and compaction as appended superseding or boundary events instead of rewriting prior model-visible history.
- Apply the same instruction and persistence pipeline to main agents and subagents without reintroducing agent profiles.

## Capabilities

### New Capabilities

- `node-layered-instruction-context`: Defines Node runtime instruction layers, context sources, authority roles, cache classes, budgeting, provider projection, and main-agent/subagent parity.
- `append-only-model-input-ledger`: Defines immutable persistence and reconstruction of every model-visible input, exact provider request manifests, persist-before-send ordering, supersession, continuation, and compaction boundaries.

### Modified Capabilities

None.

## Impact

- Affects `backend/packages/core`, `runtime`, `storage`, `integrations`, `providers`, and `backend/apps/mycli`.
- Extends the SQLite session schema and canonical context/request contracts while retaining compatibility readers for existing sessions.
- Changes Node provider request construction from static options plus transient history to persisted layered request shapes.
- Does not remove or replace the Python runtime and does not require TUI-visible rendering of internal context records.
