# Shell Execution Policy Contract

> Sandbox-first command classification, approval, escalation authorization, and durable recovery.

## Scenario: Sandbox-First Shell Execution And Escalation

### 1. Scope / Trigger

- Trigger: changing Shell command parsing, safe or dangerous command tables, execution-policy
  rules, provider-visible Shell arguments, approval decisions, tool execution options, sandbox
  process selection, or approval continuation recovery.
- The contract applies to the Node `Shell` route. The legacy `Bash` route keeps its existing
  provider schema and unknown-command approval behavior.

### 2. Signatures

- Classification:
  `classifyShellCommand(command, { shellKind, platform?, workspaceRoot? }) ->`
  `safe | dangerous | unknown | complex | invalid`.
- Policy:
  `ApprovalPolicy.evaluate(call, executionPolicy?) -> allow | request | deny`.
- Provider argument:
  `sandbox_permissions?: "use_default" | "require_escalated"` on `Shell` only.
- Display-only provider argument:
  `description?: string` on `Shell`, bounded to 512 characters.
- Host-only execution option:
  `ToolExecutionOptions.sandboxOverrideApproved?: boolean`.
- Recovery derivation:
  `shellCallRequestsSandboxOverride(call) -> boolean` from the exact canonical call.

### 3. Contracts

- Explicit execution-policy rules are evaluated per parsed command segment before safelist or
  dangerous-command defaults. `deny` remains denied, `ask` remains approval-gated, and an exact
  `allow` rule may authorize that segment.
- In a restricted profile, a plain unknown non-dangerous `Shell` command is allowed to run in the
  active sandbox. It is not pre-approved for host execution.
- Dangerous or complex restricted commands request approval. Invalid arguments or malformed
  commands fail closed. Full Access does not prompt for valid calls, but explicit `ask`/`deny`
  rules and malformed calls still fail closed.
- `require_escalated` requests approval in a restricted profile unless every parsed segment is
  authorized by an applicable allow/session rule. An allow decision carries
  `sandboxOverrideApproved=true` only for the exact evaluated call.
- Pre-tool hooks cannot inherit escalation authority after changing a call. Runtime forwards the
  authorization bit only when `callId`, tool name, and canonical argument JSON are unchanged.
- Consecutive allowed `Shell` calls may execute concurrently. Approval evaluation remains per call;
  an approval request flushes earlier parallel work and suspends before the requested call starts.
  Each running call receives only its own exact-call sandbox authorization.
- The Shell adapter requires both the provider request and host authorization before replacing a
  restricted execution policy with `full-access`. Model arguments alone never select host
  execution.
- `description` is optional user-facing metadata. It does not alter the command, working directory,
  classification, approval decision, sandbox policy, or execution result, and it never substitutes
  for an escalation justification.
- A valid description is trimmed before it enters the in-memory Shell session and live lifecycle.
  Approval previews and policy evaluation continue to use the canonical command rather than this
  display label.
- Durable approval continuation stores the canonical call as before. On approval, it fingerprints
  and executes that exact call, deriving the authorization bit from the persisted call rather than
  adding mutable approval state. A recovered `executing` effect is interrupted as unknown and is
  never replayed.
- Sandbox failure is returned as a tool result. Runtime must not automatically retry the command
  with escalation.
- Approval persistence and TUI events contain bounded previews and structural reasons only. Do not
  persist raw model justification, command output, credentials, or arbitrary provider text.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Missing or `use_default` permission | Run under the frozen turn execution policy |
| Missing description | Execute normally |
| Empty, non-string, or over-512-character description | Reject as invalid arguments; start no process |
| Valid description | Execute the exact same command under the same policy |
| Unknown non-dangerous Shell command in workspace mode | Allow; keep restricted sandbox |
| Dangerous or complex Shell command in workspace mode | Suspend for durable approval |
| Invalid `sandbox_permissions` | Policy denies; direct adapter returns `invalid_sandbox_permissions` |
| Restricted `require_escalated` without an allow rule | Suspend for durable approval |
| Restricted adapter call with model escalation but no host bit | Return `sandbox_override_not_approved`; start no process |
| Exact allow/session rule plus escalation | Allow and forward the host authorization bit |
| Pre-tool hook changes an authorized call | Withhold the host authorization bit |
| Consecutive allowed Shell calls | Execute concurrently and persist results in provider order |
| Shell call requests approval after allowed parallel calls | Finish and persist the earlier phase, then suspend |
| Approved persisted escalation after coordinator recreation | Derive the bit and run once with full-access isolation |
| Full Access valid Shell call | Run without approval |
| Full Access call matching `ask` or `deny` | Deny without surfacing an approval prompt |
| Legacy Bash unknown command | Preserve the existing approval request |

### 5. Good/Base/Bad Cases

- Good: `python script.py` is unknown, so workspace mode runs it inside the active restricted
  sandbox without asking.
- Good: `rm -rf build` and Windows force-delete or URL GUI-launch forms request approval.
- Good: `git -C nested status` is safe only when the resolved directory remains inside the
  workspace; unsafe Git global/subcommand options do not enter the safelist.
- Base: `Shell { command: "pwd" }` uses the current policy and does not carry an override bit.
- Bad: treat every unknown command as host-trusted because it was allowed to enter the sandbox.
- Bad: trust `sandbox_permissions="require_escalated"` inside `ShellTool` without a runtime-owned
  authorization bit.
- Bad: persist a separate mutable escalation flag that can drift from the fingerprinted call.

### 6. Tests Required

- Classifier tests cover the POSIX baseline, Codex Git unsafe options, workspace-confined `git -C`,
  the intentional `git branch --list <pattern>` exception, PowerShell aliases and nested mutation,
  force deletion, CMD recursive deletion, and URL/GUI launch cases.
- Approval-policy tests assert unknown/default sandbox allow, dangerous/complex request, invalid
  enum denial, explicit rule precedence, exact escalation allowance, and Full Access behavior.
- Shell adapter tests assert an unapproved model escalation starts no process and an approved
  escalation can use an outside cwd through full-access process isolation.
- Runtime tests assert the normal allow path forwards the bit only for an unchanged canonical call.
- Runtime tests assert allowed Shell calls overlap while preserving per-call sandbox authorization
  and provider-order result persistence.
- Approval continuation tests recreate the coordinator from persisted state and assert that an
  approved escalation derives and forwards the bit.
- Provider and manifest tests assert the optional enum and description are projected while
  `command` remains the only required Shell field.
- App integration drives a real Shell escalation through approval and resumes the original agent
  turn. Tools, runtime, provider, app, and TUI regression suites remain green.

### 7. Wrong vs Correct

#### Wrong

```typescript
if (argumentsValue.sandbox_permissions === "require_escalated") {
	return runWithPolicy(executionPolicy("full-access", workspaceRoot));
}
```

#### Correct

```typescript
const requested = argumentsValue.sandbox_permissions === "require_escalated";
if (requested && !hasUnrestrictedFilesystem(activePolicy)
	&& options.sandboxOverrideApproved !== true) {
	return shellFailure("sandbox_override_not_approved", "Shell sandbox override was not approved.");
}
const effectivePolicy = requested
	? executionPolicy("full-access", workspaceRoot)
	: activePolicy;
```
