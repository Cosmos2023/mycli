# Current Runtime Policy Shape

## Existing enforcement

- `AgentRuntime` constructs `ApprovalService(SafetyPolicy(...))` and
  `RuntimePolicyGate`, then injects the gate into `ToolExecutionService`.
- `ToolExecutionService.execute_tool_call()` asks the runtime gate for a
  decision before calling `tool_router.execute()`.
- Non-allowed decisions become tool results without executing the underlying
  tool.
- `SafetyPolicy` already classifies safe tools, workspace mutation tools,
  `KillShell`, and `Bash`.
- `BashTool` also performs a second `analyze_shell_command()` check and keeps
  shell `cwd` inside the workspace.
- `ToolRouter` already rejects tool calls not exposed for the current turn.

## Existing diagnostics

- `ToolRuntimeDecision.to_trace_payload()` emits bounded decision fields:
  decision, policy, risk level, argument key/count, and sandbox shape.
- `DoctorService` summarizes `runtime_policy_decision` rows.
- `RuntimeDryRunDiagnostics` summarizes policy decisions, sandbox lane,
  approval lane, lifecycle, and session continuity.

## P14 insertion point

`RuntimePolicyGate.decide()` is the best insertion point. It already owns the
projection from local safety/approval policy into `ToolRuntimeDecision` and is
called before tool execution. Execpolicy should be evaluated before
`ApprovalService.evaluate()` for matching shell commands, while unmatched
commands should keep current safety behavior.

## Rule source proposal

- User: `home_dir / ".mycli" / "rules" / "default.rules"`
- Project: `workspace_root / ".mycli" / "rules" / "default.rules"`
- Project rules override user rules by source precedence when multiple rules
  match.
- Session rules are represented in the resolver API as a future extension
  point but are not productized in P14.

## Redaction boundary

Trace/doctor/dry-run may expose:

- `execpolicy_decision`
- `execpolicy_rule_source`
- `execpolicy_rule_pattern_hash`
- `execpolicy_rule_pattern_length`
- `execpolicy_rule_argument_count`

They must not expose:

- raw command
- raw argument values
- rule pattern tokens
- secrets
- provider payload bodies
