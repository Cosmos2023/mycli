# Memory Trigger And Child Tool Isolation Design

## Summary

mycli currently has one master memory switch, one extraction interval, and an
independently gated dream service. The configuration cannot explicitly disable
extraction or dream, and `extraction_interval_turns = -1` disables explicit
"remember this" requests as well as automatic extraction. Background memory
agents also execute tools through the shared main-session router without carrying
their child session owner. Shell lifecycle events can consequently appear in the
main TUI and look like commands run by the main agent.

This design gives extraction and dream independent switches, makes the extraction
interval describe automatic extraction only, and introduces an invocation-scoped
tool owner. Internal memory tools remain available to their child agents and in
diagnostic traces, but never enter the main transcript or resumed history.

## Goals

- Make the memory master switch and subfeature switches unambiguous.
- Preserve the existing default extraction and dream behavior.
- Allow explicit remember/forget requests when automatic extraction is disabled.
- Let users disable extraction or dream independently.
- Assign every child tool invocation to its child session without mutating shared
  tool instances.
- Keep memory extraction and dream tool activity out of the main TUI and main
  session history.
- Cover the leaked dream Shell output from session
  `39a0864f-fa21-4878-9bdf-580b7ff855d1` with a regression test.

## Non-Goals

- Replacing memory extraction prompts or changing which facts are worth saving.
- Replacing the dream consolidation algorithm.
- Building a unified scheduler for every background job type.
- Showing memory child-agent progress in the main transcript.
- Rewriting existing session files or deleting existing memory files.
- Changing the main agent's Shell presentation.

## Current Behavior

After a successful assistant turn, `TurnExecutor` performs these memory actions
when `memory_enabled` is true:

1. append the assistant response to the session summary store;
2. ask `MemoryExtractionService` whether extraction should start;
3. ask `MemoryDreamService` whether consolidation should start.

Extraction defaults to every five eligible turns. A negative interval returns
before explicit-request detection, so `-1` disables all extraction. Dream is still
checked because it only depends on the master memory switch. It starts when memory
files exist, at least 24 hours have passed, at least five other recent sessions
exist, and no dream run is active.

`RuntimeChildToolExecutor` receives a `child_session_id` but discards it. It then
uses the shared `ToolRouter`, whose Shell executors retain the main session owner in
mutable instance state. The Gateway correctly filters lifecycle events by owner,
but leaked child events carry the main owner and therefore pass that filter.

## Configuration Contract

The user-facing TOML contract is:

```toml
[memory]
enabled = true
extraction_enabled = true
extraction_interval_turns = 5
dream_enabled = true
dream_min_hours = 24
dream_min_sessions = 5
```

The corresponding runtime fields are:

```text
memory_enabled
memory_extraction_enabled
memory_extraction_interval_turns
memory_dream_enabled
memory_dream_min_hours
memory_dream_min_sessions
```

Environment variables use the existing naming convention:

```text
MYCLI_MEMORY_ENABLED
MYCLI_MEMORY_EXTRACTION_ENABLED
MYCLI_MEMORY_EXTRACTION_INTERVAL_TURNS
MYCLI_MEMORY_DREAM_ENABLED
MYCLI_MEMORY_DREAM_MIN_HOURS
MYCLI_MEMORY_DREAM_MIN_SESSIONS
```

### Semantics

| Configuration | Behavior |
| --- | --- |
| `enabled = false` | Disable session summaries, extraction, and dream. |
| `enabled = true` | Persist session summaries after successful turns. |
| `extraction_enabled = false` | Disable automatic and explicit extraction. |
| `extraction_interval_turns = -1` | Disable automatic extraction only. |
| `extraction_interval_turns >= 1` | Run automatic extraction every N eligible successful turns. |
| `dream_enabled = false` | Do not check or start dream consolidation. |
| `dream_enabled = true` | Check the configured time and session gates after successful turns. |

Explicit remember/forget detection occurs before the automatic interval gate.
Direct memory writes by the main agent still suppress extraction for that turn,
preventing duplicate updates. The in-progress guard still permits at most one
extraction and one dream run at a time.

### Defaults And Compatibility

The new fields default to `true`, `24`, and `5`, preserving current behavior when
they are absent. Existing sectioned and legacy flattened configuration remains
readable. Existing `extraction_interval_turns = -1` keeps automatic extraction
disabled, but explicit memory requests begin working as implied by the new
contract.

For compatibility, interval `0` continues to normalize to `1`. Values below `-1`
are rejected with a configuration error instead of silently changing meaning.
Dream thresholds below `1` are also rejected. Configuration serialization writes
the canonical `[memory]` section and the new fields.

## Successful-Turn Flow

The successful-turn finalization path becomes:

```text
memory_enabled?
  no  -> skip all memory work
  yes -> append session summary
         |
         +-> memory_extraction_enabled?
         |     yes -> check direct write, explicit request, interval, in-progress
         |
         +-> memory_dream_enabled?
               yes -> check files, elapsed time, recent sessions, in-progress
```

Rejected, aborted, or failed turns do not trigger extraction or dream. Existing
special persistence of compaction summaries remains unchanged because it serves a
different recovery path.

Both services continue to run asynchronously on their single-worker executors.
Starting them must not delay delivery of the completed main response.

## Invocation-Scoped Tool Ownership

Introduce an immutable internal context:

```python
@dataclass(frozen=True, slots=True)
class ToolInvocationContext:
    owner_session_id: str
```

`ToolRouter.execute` accepts an optional invocation context. It installs the
context for the duration of one synchronous tool invocation and always restores
the previous value in `finally`. The implementation uses `ContextVar`, so
concurrent main-agent and child-agent calls do not mutate shared state or inherit
another thread's owner accidentally.

`RuntimeChildToolExecutor` passes the provided `child_session_id`:

```text
main agent        -> main session ID (existing configured fallback)
memory extraction -> <session>:memory:<turn>:<random>
memory dream      -> <session>:dream:<turn>:<random>
subagent          -> existing child session ID
```

The Shell tool family resolves its owner from the active invocation context,
falling back to its configured owner for existing direct callers. This applies to
`Bash`, `ShellOutput`, `WriteStdin`, and `KillShell`. The owner is copied into the
shell registry request when a process starts; later lifecycle events and polling
therefore retain the correct owner even after the invocation context has ended.

The owner is internal runtime metadata. It is not part of a model-visible tool
schema, cannot be supplied by model arguments, and is not included in model tool
output.

## TUI And Persistence Boundaries

The Gateway continues to emit Shell lifecycle events only when
`event.owner_session_id` equals the currently bound main session. Correct owner
propagation makes this filter effective for all child agents.

Memory extraction and dream behavior is therefore:

- tool calls and outputs are available to the internal child loop;
- diagnostic trace and raw model logging retain enough evidence for debugging;
- Shell lifecycle rows are not sent to the main TUI;
- child tool items are not appended to the main session history;
- `/resume` reconstructs only the main conversation and its main-agent tools;
- no synthetic notice is added when routine background memory work starts or
  finishes.

The change does not hide user-started main-agent background Shell sessions. Those
continue to use the main owner and appear in `/ps`, lifecycle output, and the main
tool transcript.

## Failure And Shutdown Behavior

- A configuration error identifies the exact memory key and invalid value.
- Extraction and dream failures remain trace events and do not interrupt a
  successfully completed main turn.
- The in-progress flag is cleared in `finally`, including model, tool, and write
  failures.
- Background Shell processes remain owned by the child that created them.
- Runtime shutdown terminates or detaches child-owned resources using their owner;
  it must not terminate unrelated main-agent Shell sessions.
- Gateway filtering remains as a defensive boundary even after owner propagation
  is fixed.

## Testing

### Configuration

- defaults preserve `true / 5 / true / 24 / 5`;
- sectioned TOML, legacy flattened TOML, and environment overrides resolve;
- explicit false values are not lost through truthy fallback expressions;
- interval `-1`, legacy `0`, and invalid values follow the documented contract;
- canonical serialization includes all memory fields.

### Extraction And Dream

- explicit extraction runs with interval `-1`;
- `extraction_enabled = false` blocks explicit and automatic extraction;
- automatic extraction starts on the configured eligible turn;
- direct main-agent memory writes and active extraction suppress duplicate work;
- `dream_enabled = false` bypasses the dream service;
- time, session, file, and in-progress dream gates remain independently covered;
- unsuccessful turns do not invoke either service.

### Tool Ownership

- a child invocation passes its owner through `ToolRouter` to every Shell-family
  operation;
- main and child Shell calls executed concurrently retain distinct owners;
- nested or failed invocations restore the prior context;
- a background process keeps the child owner after the initiating call returns;
- model-visible schemas and outputs do not expose owner metadata.

### Regression Coverage

Reproduce the shape of session `39a0864f-fa21-4878-9bdf-580b7ff855d1`: a due
dream run executes `find`, `ls`, and `cat` while the Gateway is attached to the
main session. Assert that:

- the child receives each tool result;
- trace events identify the dream child session;
- the Gateway emits no child Shell rows;
- main session history contains no dream tool items;
- main-agent Shell events still render normally.

## Acceptance Criteria

- Users can independently disable extraction and dream.
- `-1` disables automatic extraction without disabling explicit memory requests.
- Default installations retain the current five-turn and 24-hour/five-session
  behavior.
- Background memory commands never appear in the main TUI or resumed transcript.
- Main and child Shell execution can overlap without owner leakage.
- Existing configuration and main-agent Shell tests remain passing.
