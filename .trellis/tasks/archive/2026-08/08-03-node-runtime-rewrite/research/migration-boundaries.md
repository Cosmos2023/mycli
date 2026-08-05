# Python-to-Node Migration Boundaries

## Current Composition

`src/mycli/cli/bootstrap.py` constructs configuration, provider adapters, tools, skills, MCP,
`AgentRuntime`, and `TurnService`. The Python gateway translates this application surface into a
line-delimited JSON-RPC protocol consumed by the Node TUI.

This is a useful migration boundary, but the current ownership direction is inverted relative to
the target: Python is the parent and Node is the child.

## Target Process Model

```text
Node npm CLI (parent)
  |- TUI and terminal ownership
  |- backend/capability router
  |- native TypeScript runtime slices
  `- Python sidecar (temporary, RPC only)
```

Node must reserve terminal streams for the TUI and use dedicated sidecar pipes for RPC. Sidecar
stderr is captured as diagnostics and never rendered as protocol input.

## Migration Unit

Use vertical capabilities, not directories, as migration units. A slice owns its contract,
application behavior, side effects, persistence, events, and tests end to end.

The first slice is a no-tool turn with:

- existing config/auth loading;
- Responses and OpenAI-compatible Chat;
- normalized streaming/reasoning events;
- explicit cancellation and retry exhaustion;
- current SQLite append-only session writes;
- existing TUI event projection;
- explicit rejection of tool calls.

## Contract Extraction

Extract the current gateway request/event definitions into versioned JSON Schema documents.
Schemas should cover envelopes and discriminated payloads rather than a single unstructured
object. Every RPC handshake includes a protocol version and advertised capabilities.

Contract tests must check:

- generated TypeScript is current;
- Python and Node accept valid fixtures;
- both reject invalid fixtures with stable error codes;
- unknown additive fields remain compatible where the schema permits them;
- protocol-version mismatch fails before a turn begins.

## Routing And Rollback

During migration, routing is explicit by capability. A turn must be assigned to one backend
before any provider request or side effect starts. It cannot switch backend mid-turn.

Rollback means changing the configured backend before a later turn or installing the prior
release. It does not mean automatically replaying a failed operation through Python.

## Persistence Compatibility

Keep the current required SQLite schema frozen during coexistence. Fixtures cover four paths:

1. Python writes, Python reads.
2. Python writes, Node reads.
3. Node writes, Python reads.
4. Node writes, Node reads.

Compare logical records, ordering, null/default behavior, Unicode, large tool payloads, partial
turns, and crash recovery. Do not hold a transaction open across a provider stream.

## Risk-Ordered Migration

1. Contract generation and fixture corpus.
2. Node parent/sidecar lifecycle.
3. Pure request projection and turn state.
4. No-tool provider turn and session append.
5. Read-only filesystem/search tools.
6. Mutation tools, approvals, and sandbox enforcement.
7. Compaction, memory, queues, steering, and recovery.
8. Persistent PTY shell and background processes.
9. MCP, plugins, hooks, subagents, and diagnostics.
10. Python removal and packaging cleanup.

The order places process safety, PTY, and multi-actor orchestration after the basic event and
persistence contracts have proven stable.

## Parity Gates

Each slice requires:

- unit tests for pure decisions;
- contract fixtures shared across languages;
- black-box event-stream comparison with unstable identifiers normalized;
- cross-backend persistence tests where data is involved;
- interruption and crash tests for asynchronous work;
- minimum-Node and three-platform CI where process behavior is involved;
- an explicit feature switch and rollback note.

