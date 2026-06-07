# Current Sandbox Policy Shape

## Existing Runtime Gate

`RuntimePolicyGate` currently decides a tool call with:

1. shell execpolicy prefix rules for `Bash` / `run_shell`;
2. contributed-tool exposure allow;
3. `ApprovalService.evaluate(call)` safety policy.

It emits `ToolRuntimeDecision` through `ToolExecutionService` as
`runtime_policy_decision` trace rows.

## Existing Effect Metadata

`ToolEffectProfile` is the local bounded summary of a tool's side effects:

- `filesystem`: `none`, `read`, `write`, or `unknown`
- `network`: bool
- `process`: bool

`ToolRouter.effect_profile(call, exposure=...)` resolves this metadata for
registry and contributed tools. `ToolExecutionService` already computes the
effect profile before calling `_runtime_policy_decision(...)`.

## P15c Fit

The minimal path is to pass `ToolEffectProfile` into `RuntimePolicyGate.decide()`
and add a sandbox denial check before execpolicy and approval evaluation.

This keeps sandbox enforcement provider-free and avoids hard-coding most tool
names. The only name-based special case needed is shell disabling: process
effects are broader than shell execution because read-only git tools also spawn
processes. P15c should block `Bash` / `run_shell` when `shell=disabled`, while a
future phase can decide whether a separate process policy should cover all
process-spawning tools.

## Redaction Boundary

Sandbox diagnostics should expose only:

- tool name / call id;
- decision and policy names;
- reason code;
- argument keys and counts;
- sandbox summary;
- effect profile summary.

They must not expose raw command text, raw argument values, stdout/stderr,
provider payload bodies, headers, or secret-like values.
