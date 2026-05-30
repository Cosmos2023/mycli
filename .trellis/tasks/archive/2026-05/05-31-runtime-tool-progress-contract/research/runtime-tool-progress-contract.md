# Runtime Tool Progress Contract Research

## Existing Behavior

- `ToolExecutionService` already emits real execution lifecycle events through
  `lifecycle_sink`:
  - `tool_start` before the local tool runs
  - `tool_complete` after a successful `ToolResult`
  - `tool_failed` after an unsuccessful `ToolResult`
- `NodeTuiGateway._forward_stream_event(...)` maps those runtime stream events
  to `tool.start`, `tool.complete`, and `tool.failed` notifications and does
  not also emit generic `turn.event` rows for them.
- The runtime/TUI contract spec already describes Hermes-like tool lifecycle
  channels but currently omits `tool.progress` from the implemented runtime
  path.
- The first available real progress point is after `tool.start` and before
  tool execution returns: the runtime knows the stable tool id, call id, name,
  compact context, and args preview, but does not yet know summary, success, or
  duration.

## Recommended Slice

- Add a `tool_progress` runtime stream event emitted immediately after
  `tool_start` and before tool execution.
- Use payload fields that match Hermes-like lifecycle routing without implying
  fake percentage progress:
  - `tool_id`
  - `call_id`
  - `name`
  - `stage`: `"executing"`
  - `message`: compact human-readable progress label
  - optional `context`
  - optional `args_preview`
- Map `tool_progress` to `tool.progress` in `NodeTuiGateway`.
- Keep `tool.progress` as a runtime/diagnostic signal only. It must not alter
  provider transcript messages, stable tool schemas, request shape, trace
  persistence, or final `TurnResponse.activity_events`.

## Tradeoffs

- A single `stage=executing` progress event is less rich than per-tool
  granular progress, but it establishes the channel with no new tool API and
  no fabricated percentages.
- Emitting progress after start means current Node TUI clients may ignore it
  safely until a later display slice consumes it.
- Keeping the event out of final transcript rows avoids duplicate tool summary
  noise while still enabling future live UI, extension, ACP, or log consumers.

## Risks

- Duplicating `tool.start` payload exactly would make `tool.progress` low value.
  - Mitigation: include an explicit `stage` and message describing execution.
- Future tools may want richer progress.
  - Mitigation: keep payload additive and stage-based rather than percent-based.
- TUI reducer does not yet consume `tool.progress`.
  - Mitigation: this slice is the runtime contract slice; TUI consumption is a
    follow-up.
