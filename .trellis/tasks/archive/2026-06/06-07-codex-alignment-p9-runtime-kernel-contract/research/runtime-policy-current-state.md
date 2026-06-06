# Runtime Policy Current State

## Read Sources

- `docs/parity/codex-alignment-phases-p9-p13.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/backend/tool-manifest-contract.md`
- `.trellis/spec/backend/plugin-runtime-contract.md`
- `.trellis/spec/backend/file-mutation-tool-contract.md`
- `src/mycli/services/approval/approval_service.py`
- `src/mycli/services/approval/safety_policy.py`
- `src/mycli/application/runtime/model/assistant_block_consumer.py`
- `src/mycli/application/runtime/tools/tool_execution_service.py`
- `src/mycli/application/runtime/ledger/runtime_event_ledger.py`
- `src/mycli/services/diagnostics/doctor.py`
- `src/mycli/services/tracing/trace_service.py`

## Current Flow

Model tool calls are consumed by `AssistantBlockConsumer`.

The current consumer:

- rejects unsupported tools before execution,
- calls `SafetyPolicy.evaluate()` directly for session allowance checks,
- calls `ApprovalService.evaluate()` for deny / pending approval / auto approval,
- persists `PendingDecision` and `SuspendedTurn` for approval-required calls,
- executes auto-allowed tools through callbacks into `ToolExecutionService`.

`ToolExecutionService` records start/result, file history, hooks, transcript tool messages, skill instruction messages, and `tool_execution` trace rows. It currently does not have an explicit runtime policy gate before execution. Hook denial is handled inside `ToolExecutionService`, but approval/safety policy is mostly handled before the service is called.

`ToolRouter` validates turn exposure and dispatches builtin or contributed tools. MCP, plugin, skill, and subagent contributed tools flow through the same router path once exposed.

Doctor already summarizes:

- approval diagnostics via trace kinds such as `approval_resolution`, `approval_allowance`, `approval_auto_allowed`,
- tool execution diagnostics via `tool_execution` rows.

## P9 Design Implication

P9 should not invent a separate approval model. It should wrap and expose existing behavior as a runtime policy contract:

```text
ToolCall + ToolExposure + ExecutionPolicy
  -> RuntimePolicyGate
  -> ToolRuntimeDecision
  -> trace runtime_policy_decision
  -> execute / deny / suspend
```

The first implementation should keep `AssistantBlockConsumer` behavior intact while replacing scattered direct approval checks with the same runtime decision object used by `ToolExecutionService`.

`ToolExecutionService` should receive a policy gate and enforce it at the execution boundary. This prevents alternate entry points such as approval resume, batched safe calls, or direct tests from bypassing the runtime policy contract.

## Redaction Boundary

Trace and doctor diagnostics may include:

- tool name,
- call id,
- decision kind,
- policy name,
- risk level,
- effect profile summary,
- argument count and argument keys,
- sandbox summary,
- approval option availability.

Trace and doctor diagnostics must not include:

- raw user prompt,
- raw tool output,
- raw command text,
- raw full arguments,
- secrets,
- full provider keys,
- full `prompt_cache_key`.

## Compact Boundary

P9 must not change compact or rehydration implementation. Existing compact behavior appears in `TurnExecutor` and compaction services. P9 work should avoid these files except read-only inspection.
