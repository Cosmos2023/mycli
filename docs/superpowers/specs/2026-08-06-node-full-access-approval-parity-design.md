# Node Full-Access Approval Parity Design

## Problem

The Node TUI advertises `Full Access` as allowing files and network without approval. Selecting it
currently updates only `ExecutionPolicyCoordinator`, which changes the sandbox to
`danger-full-access`. `ApprovalPolicy` is constructed independently and never receives later
permission-profile changes, so unknown Shell commands and request-policy extension tools still
emit `approval.request`.

This differs from the retained Python reference. Python evaluates sandbox and explicit exec-policy
rules first, then lets `FULL_ACCESS` skip routine approval. Explicit `ask` and `deny` rules remain
authoritative.

## Approaches

### 1. Make ApprovalPolicy permission-aware (selected)

Add `permissionProfile` to `ApprovalPolicyOptions` and a validated
`setPermissionProfile(profile)` method. The existing runtime configuration path updates both the
execution sandbox and approval policy. `ApprovalPolicy.evaluate` preserves malformed-call and
explicit-rule handling, then auto-allows routine full-access Shell and extension requests.

This keeps decision precedence in one policy class and gives unit tests a direct contract.

### 2. Bypass requests in NodeTurnRuntime

`NodeTurnRuntime` could inspect the execution-policy snapshot and convert an approval request into
allow. This is smaller at first, but duplicates decision precedence outside `ApprovalPolicy` and
risks overriding explicit `ask` rules because the request no longer carries enough provenance.

### 3. Merge execution and approval coordinators

A unified runtime-policy service would remove the split completely. It has a much larger blast
radius across turn snapshots, recovery, tools, and diagnostics and is unnecessary for this parity
fix.

## Selected Design

`ApprovalPolicy` owns the routine-approval decision and current permission profile. Its decision
order is:

1. Reject malformed arguments or unsupported tool names.
2. For Shell/Bash, parse the command and apply explicit exec-policy rules.
3. Keep explicit `deny`, `ask`, and `allow` results unchanged.
4. If the profile is `full-access`, allow a valid routine Shell command that has no explicit rule.
5. If the profile is `full-access`, allow a known extension tool whose normal metadata is
   `request`; unknown extensions remain denied.
6. Otherwise retain existing safe-command, session allowance, mutation, and extension behavior.

`NodeTurnRuntime.configureExecutionPolicy` remains the single runtime configuration entrypoint. It
updates `ExecutionPolicyCoordinator` and calls a small approval-policy configuration adapter owned
by the Node backend. The gateway continues to enforce workspace trust separately, and the active
turn keeps its existing execution-policy snapshot semantics.

## Data Flow

```text
TUI Full Access
  -> permissions.update(profile=full-access)
  -> NodeGateway.configureExecutionPolicy
  -> NodeTurnRuntime.configureExecutionPolicy
  -> ExecutionPolicyCoordinator.configure (sandbox/network)
  -> ApprovalPolicy.setPermissionProfile (routine approval)
  -> next eligible tool call uses full-access decision precedence
```

## Error And Safety Behavior

- Invalid permission values remain `invalid_params` at the gateway boundary.
- Untrusted workspaces still disable tool execution before approval evaluation.
- Malformed JSON, invalid Shell syntax, and unknown tool names remain denied.
- Explicit project/user/session `deny` and `ask` rules are not weakened.
- Full access does not suppress clarification, login, provider, OS, or extension-host lifecycle
  errors.

## Tests

- Unit: `ApprovalPolicy` defaults to workspace behavior and updates to full access.
- Unit: routine unknown Shell and request-policy extension tools become allowed in full access.
- Unit: explicit `ask` and `deny`, malformed calls, and unknown tools remain unchanged.
- Gateway/runtime integration: `permissions.update(full-access)` reaches the approval policy.
- M6 integration: the approved PTY command completes without an `approval.request` under full
  access.
- Regression: workspace profile still produces the existing approval flow.

## Scope Boundary

No new command, schema, persistence record, or environment variable is introduced. The fix changes
only the meaning already promised by the existing `full-access` permission profile.
