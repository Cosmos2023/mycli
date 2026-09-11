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
- Legacy display-only argument accepted by dispatch, absent from the provider schema:
  `description?: string` on existing `Shell` calls, bounded to 512 characters.
- Model-provided approval argument:
  `justification?: string` on `Shell`, bounded to 512 characters.
- Host-only execution option:
  `ToolExecutionOptions.sandboxOverrideApproved?: boolean`.
- Host-only upper bound:
  `ToolExecutionOptions.sandboxOverridePolicy?: ExecutionPolicy`.
- Approval scheduling: `ParallelApprovalCoordinator.respond({ decisionId, choice })` wakes only
  the matching invocation; Shell arguments retain their ordinary yield semantics.
- Recovery derivation:
  `shellCallRequestsSandboxOverride(call) -> boolean` from the exact canonical call.
- Windows helper setup: `mycli-windows-sandbox.exe --ensure-setup`.
- Windows helper state reset: `mycli-windows-sandbox.exe --reset`.
- Windows restricted execution: `mycli-windows-sandbox.exe --request-json <json>`.

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
- Consecutive parallel-capable `Shell` calls independently await their own approvals and execute.
  All pending requests in the phase are durable before the first prompt. Responding advances the
  prompt without waiting for that invocation's result. Each call keeps its exact-call authority.
- The system prompt explicitly permits independent `Shell` calls in the same response, including
  `require_escalated`, and distinguishes their approval queue from sequential-only
  `request_permissions` and `AskUserQuestion` calls. Keep commands separate for individual decisions;
  do not merge them merely to obtain one approval. Approval and completion dependencies still gate
  execution. Prompt revisions apply to new session snapshots; existing sessions retain their frozen
  instructions.
- Approved Shell calls use normal clamped `yield_time_ms`; there is no host-only zero-yield hint.
  Completion or the yield deadline returns the invocation result. Early completion cancels the
  unused deadline timer. A running handle is not a successful exit, and provider continuation waits
  for ordered phase results. Sequential/legacy tools retain their existing barriers.
- The shell manager owns yielded processes, output, timeout, stop, and shutdown cleanup. Process
  completion dependencies use `WriteStdin`; independent calls may advance while it runs.
- The Shell adapter requires both the provider request and host authorization before applying the
  runtime-owned override policy. Without managed/runtime constraints that policy is full access;
  otherwise it remains capped. Model arguments and the approval boolean alone never select host
  execution.
- A policy with `networkDomains` is not unrestricted network access. `web_fetch` checks domains
  directly. Enabled, non-empty domain policies on macOS Shell use a process-owned proxy; Seatbelt
  permits only its loopback TCP port. Linux/Windows return `network_proxy_unavailable`. Empty or
  disabled policies and raw launches without a proxy remain offline.
- The model's escalation request never discards policy without host authorization. Full filesystem
  access alone cannot remove network bounds; an approved fallback without an explicit runtime
  override preserves the current domain list and its network-enabled state.
- `ShellStartRequest.processResource` transfers an idempotent infrastructure lease to the manager.
  Yield does not close it. Start rejection/failure, process exit, timeout, stop, and manager shutdown
  close it, including inconclusive process termination. See [Network Proxy Contract](./network-proxy-contract.md).
- Legacy `description` is optional user-facing metadata. It does not alter the command, working directory,
  classification, approval decision, sandbox policy, or execution result, and it never substitutes
  for an escalation justification.
- A valid description is trimmed before it enters the in-memory Shell session and live lifecycle.
  Approval previews and policy evaluation continue to use the canonical command rather than this
  display label.
- The model includes a concrete user-facing `justification` in the original `Shell` call with
  `sandbox_permissions="require_escalated"`, phrased as an approval question explaining the action
  and additional access need in the user's language. Ordinary calls omit it. This is optional
  display metadata: missing reasons enter the normal approval flow without another provider request,
  forced correction, or fabricated reason. Legacy `description` remains an ordinary command summary.
  Supplied empty, non-string, or over-limit reasons fail existing argument validation. The text never
  grants authority, and its absence does not change policy decisions, approval choices, or recovery.
- Shell approvals render one optional `Reason` line: sanitized model justification first, then the
  runtime policy reason, then no line. The generic policy summary must not hide the model's question.
  There is no separate `Approval` line or description fallback. Preserve both fields in gateway
  records and their original storage locations; apply the same display selection to live and
  restored requests without changing the policy decision.
- Durable approval continuation stores the canonical call as before. On approval, it fingerprints
  and executes that exact call, deriving the authorization bit from the persisted call rather than
  adding mutable approval state. A recovered `executing` effect is interrupted as unknown and is
  never replayed.
- Sandbox failure is returned as a tool result. Runtime must not automatically retry the command
  with escalation.
- On Windows, the native helper validates the sandbox request before any first-use setup. A valid
  restricted request with missing setup state requests elevation, waits for setup to finish, and
  verifies the resulting identity and firewall state before starting the command. Cancellation,
  setup failure, or incomplete state fails closed and the command does not run.
- Setup and reset share one owner-scoped mutex. Reset is idempotent and removes only the encrypted
  credential plus setup markers; it never deletes the dedicated account, removes firewall/WFP
  restrictions, or grants broader access. UAC cancellation exits through the stable helper code `2`
  and the Node recovery adapter projects it as `operation_canceled` without native stderr.
- Durable policy summaries retain structural reasons. Canonical tool-call arguments retain the
  model's user-facing justification as part of the exact call. Interactive events expose only its
  trimmed, credential-redacted, control-escaped, 512-character projection through
  `shellApprovalPreview`; bound after escaping and mark truncation with an ellipsis. Recompute the
  same projection after restart/session resume, without copying raw reasons into diagnostic output.
- Shell approval reasons explain the permission check in plain language. Do not expose internal
  override terminology or raw parser categories, substitute the command description, or infer a
  specific network/filesystem need or an earlier execution failure from an escalation request.
- Interactive Shell/Bash approvals additionally project the canonical `command` through
  `shellApprovalPreview` into `command_preview` (up to 12,000 characters) and `command_truncated`.
  Preserve command syntax and whitespace, redact common credential values, escape terminal controls,
  and mark truncation explicitly. Apply the same projection to live and recovered requests. The
  durable 512-character policy summary and canonical execution input keep their existing roles;
  display fields must never become execution input or change approval choices.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Missing or `use_default` permission | Run under the frozen turn execution policy |
| Missing description | Execute normally |
| Empty, non-string, or over-512-character description | Reject as invalid arguments; start no process |
| Valid description | Execute the exact same command under the same policy |
| Shell call needs approval but justification is missing | Publish the normal approval with its policy explanation; do not request another model response for a reason |
| Allowed call or previously persisted approval lacks justification | Preserve existing execution/recovery behavior |
| Runtime reason and valid justification | Show the sanitized model question under `Reason`; preserve the runtime policy reason separately in state |
| Valid justification without runtime reason | Show the sanitized model question under `Reason` |
| Neither runtime reason nor justification | Omit the reason line; preserve command and approval choices |
| Empty, non-string, or over-512-character justification | Reject as invalid arguments; start no process |
| Unknown non-dangerous Shell command in workspace mode | Allow; keep restricted sandbox |
| Dangerous or complex Shell command in workspace mode | Suspend for durable approval |
| Invalid `sandbox_permissions` | Policy denies; direct adapter returns `invalid_sandbox_permissions` |
| Restricted `require_escalated` without an allow rule | Suspend for durable approval |
| Restricted adapter call with model escalation but no host bit | Return `sandbox_override_not_approved`; start no process |
| Exact allow/session rule plus escalation | Allow and forward the host authorization bit |
| Approved escalation under managed constraints | Apply the runtime override policy without exceeding it |
| Enabled, non-empty domain-constrained Shell on macOS | Use the frozen proxy lease and keep direct egress denied |
| Enabled, non-empty domain-constrained Shell on Linux/Windows | Fail before process start with `network_proxy_unavailable` |
| Disabled or empty domain-constrained Shell policy | Keep the sandbox network disabled |
| First valid restricted Windows request without setup | Request UAC elevation once, verify setup, then run |
| Invalid Windows sandbox request | Reject before requesting elevation |
| Windows setup canceled, failed, or incomplete | Fail closed; start no requested command |
| Confirmed Windows reset | Clear setup state under the setup mutex; retain account and network restrictions |
| Pre-tool hook changes an authorized call | Withhold the host authorization bit |
| Consecutive allowed Shell calls | Execute concurrently and persist results in provider order |
| Shell call requests approval beside allowed parallel calls | Await only that approval while allowed siblings execute |
| Approved modern Shell requests a long foreground wait | Keep its normal wait while later approvals independently advance |
| Shell startup fails | Commit a failed tool result; do not report a running handle |
| Legacy Bash or a sequential barrier | Preserve its existing wait and ordering |
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
- Good: the first valid Windows `--request-json` call serializes setup, requests UAC elevation,
  verifies the completed state, and then runs the command.
- Base: `Shell { command: "pwd" }` uses the current policy and does not carry an override bit.
- Bad: treat every unknown command as host-trusted because it was allowed to enter the sandbox.
- Bad: trust `sandbox_permissions="require_escalated"` inside `ShellTool` without a runtime-owned
  authorization bit.
- Bad: fail the first Windows request with instructions that require the user to locate and invoke
  an internal packaged helper manually.
- Bad: persist a separate mutable escalation flag that can drift from the fingerprinted call.

### 6. Tests Required

- Classifier tests cover the POSIX baseline, Codex Git unsafe options, workspace-confined `git -C`,
  the intentional `git branch --list <pattern>` exception, PowerShell aliases and nested mutation,
  force deletion, CMD recursive deletion, and URL/GUI launch cases.
- Approval-policy tests assert unknown/default sandbox allow, dangerous/complex request, invalid
  enum denial, explicit rule precedence, exact escalation allowance, and Full Access behavior.
- Shell adapter tests assert an unapproved model escalation starts no process and an approved
  escalation can use an outside cwd through full-access process isolation.
- Windows helper CI validates the `--ensure-setup` elevation path and the restricted request's
  filesystem and network boundaries. It uses `--reset`, verifies `setup_complete=false`, and then
  proves the next restricted request safely rebuilds setup. First-use setup must remain fail-closed
  when it cannot be completed.
- Runtime tests assert the normal allow path forwards the bit only for an unchanged canonical call.
- Runtime tests assert allowed Shell calls overlap while preserving per-call sandbox authorization
  and provider-order result persistence.
- Regression tests assert approved Shell and the earlier parallel Shell phase yield promptly,
  argument validation remains enforced, and ordinary/legacy waits remain unchanged.
- Approval continuation tests recreate the coordinator from persisted state and assert that an
  approved escalation derives and forwards the bit.
- Provider and manifest tests assert the optional permission enum is projected and `description`
  is omitted while `command` remains the only required Shell field. Router tests prove that legacy
  descriptions remain executable without relaxing required fields or unknown-field rejection.
- App integration drives a real Shell escalation through approval and resumes the original agent
  turn. Tools, runtime, provider, app, and TUI regression suites remain green.
- A local-provider backend test keeps the first command alive while approving and executing the
  second, checks output during pending approval, then verifies one final persisted process record.

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
