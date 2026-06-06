# Tool Lifecycle Current State

## Read Sources

- `docs/parity/codex-alignment-phases-p9-p13.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `src/mycli/application/runtime/tools/tool_execution_service.py`
- `src/mycli/application/runtime/tools/tool_orchestrator.py`
- `src/mycli/domain/runtime/protocol.py`
- `src/mycli/services/diagnostics/doctor.py`
- `tests/unit/application/test_tool_execution_service.py`
- `tests/unit/application/test_agent_runtime.py`

## Current Flow

`ToolExecutionService` is already the primary execution boundary for normal agent tool calls.

Existing per-call behavior:

- `_record_tool_start()` appends a `TOOL_CALL` turn item and emits stream `tool_start`.
- `_record_tool_outcome()` appends `TOOL_RESULT`, emits stream progress and terminal stream event, then writes a final `tool_execution` trace row.
- `execute_tool_call_for_clarification()` has a custom path for `AskUserQuestion`.
- Interrupted tools record a failed result and re-raise `KeyboardInterrupt`.
- Hook denial and P9 runtime policy denial synthesize failed tool results without executing the actual router call.

Existing contributed lifecycle:

- `ToolOrchestrator` emits `tool_lifecycle` rows for contributed tool declaration/exposure/invocation/completion.
- These are about tool contribution state, not a per-call execution lifecycle.

## P10 Design Implication

The smallest useful P10 is to persist a dedicated per-call lifecycle trace stream from `ToolExecutionService`.

Recommended trace kind:

```text
tool_runtime_lifecycle
```

Recommended payload:

```text
tool_name
tool_id
tool_call_id
phase
status
argument_count
argument_keys
policy_decision
duration_ms
error_kind
```

Doctor can check lifecycle integrity using `(turn_id, tool_call_id/tool_id)`.

## Redaction Boundary

Allowed:

- tool name
- call id
- lifecycle id
- phase/status
- argument key/count
- policy decision string
- error kind
- bounded duration

Forbidden:

- raw args
- raw command text
- raw prompt
- raw tool output
- stdout/stderr bodies
- local file contents
- headers
- secrets

## Compact Boundary

P10 should not inspect or edit compact/rehydration paths beyond final diff audit.
