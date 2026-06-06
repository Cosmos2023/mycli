# Codex Alignment P9 Runtime Kernel Contract

## Objective

Implement P9 from `docs/parity/codex-alignment-phases-p9-p13.md`: introduce a minimal runtime kernel contract for tool execution policy, sandbox description, approval gating, and bounded diagnostics.

P9 makes the existing approval/safety behavior explicit as a runtime policy surface. It does not rewrite tool lifecycle, skill behavior, context assembly, provider cache policy, or compact/rehydration.

## Problem

`mycli` already has useful primitives:

- `SafetyPolicy` classifies local tool risk and decides `auto_allow`, `needs_choice`, or `deny`.
- `ApprovalService` maps risky calls to `PendingApproval`.
- `AssistantBlockConsumer` checks approval before normal model-requested tool execution.
- `ToolExecutionService` records tool start/result trace rows.
- Doctor summarizes approval and tool execution diagnostics.

The gap is that these primitives are not a single runtime kernel contract. Policy decisions are partially embedded in the assistant block consumer, contributed tools have a separate auto-allow branch, and `ToolExecutionService` does not own an execution-before-policy gate. P9 should make policy decision an explicit object and add a defense-in-depth gate at the execution boundary.

## Requirements

1. Add minimal runtime policy domain contract:
   - `SandboxProfile`
   - `ExecutionPolicy`
   - `ApprovalGate`
   - `ToolRuntimeDecision`
   - `ToolRuntimeDecisionKind`
   - `ToolRuntimeResult`
2. The decision kind must map to:
   - `allowed`
   - `denied`
   - `needs_approval`
3. Runtime policy must reuse existing `SafetyPolicy`, `ApprovalService`, `PendingApproval`, and `PendingDecision` semantics.
4. `ToolExecutionService` must be able to evaluate a call before executing it.
5. A denied runtime policy decision must not execute the tool.
6. A `needs_approval` runtime policy decision must not execute the tool and must be representable through existing pending approval/decision fields.
7. Runtime policy decisions must be written to trace with bounded, redacted fields.
8. Doctor must summarize runtime policy diagnostics without printing raw prompt, raw tool output, raw command text, raw args, secrets, or full provider keys.
9. Existing context, request shape, prefix cache, provider cache, compact, and rehydration behavior must not be changed.

## Non-goals

- Do not touch compact or compact rehydration implementation.
- Do not mimic Codex compact rehydration.
- Do not rewrite context assembly.
- Do not modify provider request shape or provider cache policy.
- Do not remove existing skill compatibility tools.
- Do not productize P10 lifecycle states.
- Do not add third-party dependencies.
- Do not perform real provider API calls.

## Acceptance Criteria

- Runtime policy contract has unit tests.
- Tool execution policy gate has unit tests for allowed, denied, and needs approval.
- Denied-by-policy tools are not executed.
- Needs-approval tools are not executed at the execution boundary.
- Trace includes bounded `runtime_policy_decision` diagnostics.
- Doctor summarizes runtime policy decisions and distinguishes allowed, denied, and needs approval counts.
- Existing approval and tool execution tests still pass.
- Smoke coverage for context/subagent/MCP/plugin/hook does not regress if touched.
- Quality gates pass:
  - `uv run ruff check src tests evaluation`
  - `uv run mypy src/mycli`
  - `uv run pytest -q`

## Evidence Boundary

Completion must include proof that no compact/rehydration implementation files were modified. At minimum, inspect the final diff for:

- `src/mycli/domain/runtime/compaction_rehydration.py`
- `src/mycli/services/context/compaction.py`
- compact/rehydration-specific request assembly paths

These files should remain untouched unless a later explicit user request changes the scope.
