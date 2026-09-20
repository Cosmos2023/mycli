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
- Persistent allow-rule writes require an exclusive file lock. Windows delete-pending `EPERM`
  during lock creation may retry within the configured deadline; persistent permission errors
  remain write failures. Only `EEXIST` permits stale-owner recovery, and a live owner's lock
  must never be removed. No retry path may write rules before acquiring the lock.
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
  permits only its loopback TCP port. Windows uses a per-logon WFP exception for the same proxy;
  Linux returns `network_proxy_unavailable`. Empty or
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
| Enabled, non-empty domain-constrained Shell on Linux | Fail before process start with `network_proxy_unavailable` |
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
  force deletion, CMD recursive deletion, URL/GUI launch cases, and the PowerShell `&` call
  operator before a quoted executable path.
- Shell profile tests cover the POSIX `SHELL` fallback, PowerShell-first Windows detection with
  `cmd.exe` last, the documented `MYCLI_SHELL_PATH` override, ignored invalid paths, and the
  dialect reported for each profile. Console-encoding platform tests run real sessions and assert
  the PowerShell console code page is 65001 with readable non-ASCII output, and that console code
  page bytes decode to text instead of replacement characters.
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

### Windows Native Execution Contract

- Node and the native helper share explicit protocol fields, including empty deny lists. Validate
  version without integer truncation, reject embedded NULs and malformed proxy ports before UAC.
- Read-only and workspace-write (including an empty or narrowed write allowlist) retain restricted
  tokens. Online, offline, and proxy execution use distinct local accounts and encrypted credentials.
- `sandbox_ready` reflects verified identities, restricted-token creation, live network rules, and
  host permissions on the proxy sublayer. A successful setup alone must not bypass these checks.
- Match async and sync path normalization with native realpath. Windows short/long names must not
  make the same cwd appear outside the workspace.
- Private ancestors receive non-inheriting traversal and attribute access only, never directory
  listing or sibling content access. Skip ACL changes where the identity already has access;
  system install directories must not require host WRITE_DAC on every launch.
- ConPTY startup can initially report PID 0. Wait with a bounded deadline while retaining early
  output/exit, and clean up failed starts. Test transport selection must match production.
- Windows pipe transports cannot deliver console control events using Node `child.kill`.
  Their interrupt falls back to fixed `taskkill.exe /PID <owned-pid> /T /F` and reports
  termination. The controller waits for graceful interruption only when the transport reports
  delivery; ConPTY retains its control-input path. Verify descendant cleanup on local Windows,
  not only CI, and never report a pipe force-kill as a successful SIGBREAK handler invocation.
- Canonical `cmd.exe /d /s /c <command>` launches use cmd's outer quote pair, not CRT
  backslash escaping for the command operand. Keep host pipe, ConPTY, and native helper
  behavior aligned; non-cmd executables and noncanonical argument vectors retain argv encoding.
  Validate quoted executable paths and metacharacters inside quoted arguments against real
  Windows processes, including denial of sandbox writes outside granted roots.
- Windows shell selection resolves `MYCLI_SHELL_PATH` first, then PowerShell 7, then Windows
  PowerShell 5.1, then `ComSpec`/`cmd.exe`. A configured absolute path that does not exist and a
  bare name that is not on `PATH` are ignored so detection continues. The resolved shell name,
  kind, dialect, and a one-line dialect hint reach the model through the environment context;
  the executable path never does.
- Windows console output is pinned to UTF-8 before the command text: CMD runs behind
  `chcp 65001`, and PowerShell sets `[Console]::OutputEncoding` and `$OutputEncoding`. Output that
  still arrives in the console code page (OEMCP) is decoded with a fatal UTF-8 attempt first and
  then that code page, so legacy console programs produce readable text instead of replacement
  characters. Model guidance must not reintroduce `chcp` or console-encoding changes inside
  commands.
- PowerShell classification accepts a leading `&` call operator before a quoted executable path as
  a plain invocation; every other unquoted `&`, `$`, or `@` expansion remains reviewable syntax.
- Terminal writes preserve input exactly. Cooked Windows console fixtures use CRLF for Enter;
  raw-input fixtures may use LF. `WriteStdin` may return on echo before process exit. Tests and
  smoke checks must await the bounded `shell.completed` event before asserting final cleanup.
- Pass the sanitized host environment explicitly through CreateProcessWithLogonW. Preserve the
  host-owned proxy environment; never choose proxy authority from an inherited variable.
- ACL preparation and setup/reset use the owner mutex, but commands execute concurrently. Protect
  existing workspace metadata even when writable roots are narrowed. Reject metadata reparse points.
  Deny mutation rights without denying shared READ_CONTROL/SYNCHRONIZE rights needed for reads.
- Job objects attach suspended runners before resume and kill descendants on helper exit. Dynamic
  proxy exceptions are installed before resume and disappear with their host's WFP session.
- Reset requires no active helpers and clears recorded filesystem ACLs, all three credentials,
  and setup markers, retaining accounts and network blocks.
- Unsupported filesystem/network combinations fail before launch; no automatic unrestricted retry.
- Regression tests must exercise the real Node Shell adapter and native helper on Windows, including
  ConPTY input/resize, Unicode and short paths, read/write/network boundaries, cleanup, and rebuild
  after reset. Release builds consume artifacts only after the reusable Windows gate passes.

### Windows denied-read and maintenance boundaries

- Helper protocol v2 requires explicit exact deny roots and an empty glob list. Resolve managed
  workspace-relative globs in Node, including dotfiles, with hard scan/match limits. Never ignore
  these fields during approval, Full Access, grants, suspension/recovery, or agent inheritance.
- Read/view_image and mutation preparation/commit check the same deny policy. Shell overrides,
  stdio MCP, plugin commands and hooks inherit it; unsupported process backends fail closed.
- Windows uses a private desktop per runner and grants its actual logon SID before resuming.
  Capability derivation includes the sandbox account and complete write-root set, preventing
  concurrent policies and Windows owners from sharing mutable audit authority.
- Pin ACL path components without DELETE sharing; reject reparse traversal. Journal before ACL
  mutations and use additive grants so preparation never drops active deny ACEs. Denied objects
  also deny mutation/deletion; their parent denies FILE_DELETE_CHILD fallback.
  Win32 metadata-only handles do not enforce delete-sharing restrictions: `PathGuard` must request
  `FILE_READ_DATA` as well as attributes/control access. The native regression attempts to rename
  the guarded file, its directory and parent: all must fail with ERROR_SHARING_VIOLATION while held;
  renaming must succeed after release. Omitting FILE_SHARE_DELETE alone is insufficient.
  Request-level native audit tests must install an `AclJournal` and clean it on success and failure,
  restoring fixture-only deny changes first so cleanup can open its paths. Never let a failed native
  test leave its synthetic capability ACEs on host audit paths.
  `SetEntriesInAclW(REVOKE_ACCESS)` does not remove deny ACEs. Cleanup must delete both ordinary
  ACCESS_ALLOWED_ACE and ACCESS_DENIED_ACE entries for the exact recorded SID, preserving unrelated
  ACE bytes/order/flags. Regression coverage must compare a directory and child ACL against their
  baseline after grant + deny + repeated cleanup, including unrelated allow and deny entries.
- Lease records contain helper PID and creation time. A changed denied-read snapshot cannot replace
  live account-wide denies. Cleanup occurs only with no active helpers or after explicit maintenance.
- `repair`/`uninstall` require preview plus `--confirm`; stop helpers and disable/stop account processes
  before cleanup. Replay filesystem journals only as the non-elevated owner, never from the elevated
  maintenance child. Remove only managed SIDs/recorded WFP bits, not whole saved DACLs or user trees.
- Audit is bounded (2 seconds / 50k paths / 1k children per directory / depth 2); skip reparses and
  unreadable ACLs. Found public write grants must be denied successfully before the command starts.
  A NULL DACL grants everyone access, unlike an empty ACL; modifying it fails closed. Do not hide
  a discovered NULL DACL, narrow audit environment roots, or alter third-party ACLs to pass tests.
- Uninstall verifies account/state absence, not merely setup_required. Unknown account collisions,
  failed cleanup, invalid journals, and canceled elevation must retain safe, retryable state.
- Windows-target cross compilation checks declarations/linkage only. Actual MSVC/native/ConPTY/WFP
  integration remains a Windows gate, and must not be claimed from macOS tests.

### Scenario: Read-Only Windows Host Preflight

#### 1. Scope / Trigger

- Separate host compatibility diagnosis from account setup and permission mutations. Incompatible
  public paths must be identified before applying any planned audit deny, reserving denied paths,
  or granting sandbox accounts read access in `PrepareSandboxRequest`.

#### 2. Signatures

- `npm run sandbox:check-host`: Windows development checkout, after building the Release helper.
- Native `mycli-windows-sandbox.exe --check-host`: no elevation, accounts or network mutations.
- `InspectHostPublicWritePaths(cwd, writable_roots) -> PublicWriteAudit` collects standard host roots.
- `InspectPublicWritePaths(scan_roots, writable_roots)` scans explicit roots for isolated fixtures.
- `ApplyPublicWriteAudit(audit, capabilities)` rejects a known NULL DACL before applying targets.

#### 3. Contracts

- Inspection is read-only. `PublicWriteAudit` contains status, inspected/uninspectable counts,
  truncation flag and planned targets with inheritance choice. Never replace real host roots with
  fixture roots or change the environment to pass production validation.
- Diagnostic JSON fields: `status`, `code`, `scope=bounded_public_paths`, `paths_checked`,
  `paths_uninspectable`, `scan_truncated`. No paths, raw ACLs, accounts or tokens in output.
- A successful diagnostic means only no known blocker in its selected scope. It does not report
  `ready`, inspect network enforcement or replace the platform suite. Production requests retain
  the existing best-effort handling of scan bounds/inaccessible ACLs; diagnostics expose it.
- The Node development wrapper uses an absolute built-helper path, no shell, and a 10-second limit.
- ACL application reopens/pins each path and rechecks its DACL; journal recovery remains necessary
  if host state changes or a later mutation fails. A plan is not an atomic filesystem transaction.
  Application has a separate two-second budget checked before each deny. Timeout rejects execution
  with `host_audit_apply_timeout` and retains journal recovery; it must not silently drop known denies.

#### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Known NULL DACL | `blocked` / `host_null_dacl`, exit 1; no audit plan applied |
| No known blocker, bounds or inaccessible ACLs limit coverage | `partial` / `host_audit_incomplete`, exit 1 |
| No known blocker within the bounded scope | `no_known_blocker`, exit 0; never `ready` |
| DACL becomes NULL between inspection and application | Existing ACL mutator rejects; never normalize it |
| Development helper absent | `windows_sandbox_helper_missing_build_first`, exit 1 |
| Development command off Windows | `windows_sandbox_host_check_requires_windows`, exit 1 |

#### 5. Good / Base / Bad Cases

- Good: diagnose the host before setup; retain known NULL DACL rejection without prior ACL writes.
- Base: report partial bounded coverage distinctly from a known blocker or setup readiness.
- Bad: treat `no_known_blocker` as a release pass, lower real workspace integrity labels to get a
  green test, normalize third-party NULL DACLs, or omit journal recovery after applying a plan.

#### 6. Tests Required

- `windows_host_audit`: a writable path preceding a NULL DACL is unchanged on rejection; inspection
  is read-only; allowed roots are excluded; successful plans apply and clean up; a later NULL DACL
  is not overwritten; child-count truncation is recorded.
- Verify the built helper and npm wrapper on actual Windows. Experiments in `experiments/` are
  opt-in and do not change production token semantics or count as release acceptance.

#### 7. Wrong vs Correct

- Wrong: discover and mutate public paths in the same scan, then fail on an incompatible directory.
- Correct: inspect first, reject known blockers, then apply a journaled plan with fresh ACL checks.
- Wrong: assume low integrity alone fixes NULL DACLs. Actual Windows fixtures permit writes to low
  NULL DACLs and admit other same-user low processes after lowering a workspace label.
- Correct: evaluate stronger isolation in a private workspace with a broker, and validate the whole
  filesystem/process/network contract before enabling a new backend.

### Scenario: PSEC Windows Backend

- On supported hosts without legacy provisioning, protocol v2 selects `backend=psec` and readiness
  projects `windows_psec`; omitted backend stays backward-compatible and unknown backends fail.
  A `psec.v1` marker pins the backend. Loss of native support yields enforcement unavailable, not
  a fallback. Setup state and enforcement capability are reported separately.
- Dynamic APIs load only from System32. Check filesystem-deny support, create an environment and
  validate the startup attribute. Readiness is not an end-to-end security acceptance result.
- Setup/repair/uninstall for PSEC never require UAC, accounts or persistent network rules. Reset
  refuses active helpers. Repair/uninstall stop owned helpers; cleanup removes only recorded empty
  placeholders and state. Do not change third-party NULL DACLs or integrity labels.
- Preparation reserves missing metadata/deny paths and expands protected hardlink aliases; alias
  failures for those trees fail closed. Writable roots are deliberately not enumerated at launch:
  a host-created hardlink alias inside a writable root is accepted, matching the shipped Codex
  Windows sandbox. PSEC still denies every link creation inside the sandbox, so only an actor
  outside the sandbox can introduce such an alias. Launch preparation stays independent of
  workspace size. Profiling a launch is available with `MYCLI_SANDBOX_PROFILE=1` (stderr timings).
  Resolve explicit native paths through local junction/symlink chains before lease admission.
  Pin each link without WRITE/DELETE sharing and pin directory components against conversion;
  derive final local DOS paths from handles so short names identify the same lease roots. Bound
  resolution to 32 link hops and 16,384 handles; unsupported/remote targets fail closed. Retain
  those handles through process completion, release before journal cleanup, and recover stale
  placeholders before acquiring request pins. The generic Node adapter may already canonicalize
  roots; native validation must still enforce this boundary for direct helper requests.
  Protected subtrees reject reparse points. Hold policy path guards through process completion;
  preparation and journal completion run under the owner mutex. PSEC commands are independent:
  each request becomes its own kernel policy, so a command must not be rejected because a peer
  with a different filesystem or denied-read policy is active. Keep the journal's shared
  placeholder and cleanup bookkeeping, keep the launch-time alias scan and pinned roots, and keep
  the legacy restricted-token backend exclusive because it edits host ACEs. Normalize dot segments
  before containment checks and keep volume-root reads nonrecursive. Policy scans are snapshots:
  PSEC denies the untrusted link creations exercised by the probes, but an alias that already
  exists can be renamed into a running command's scope afterwards, and a command only receives the
  denies it requested. Document that boundary; do not claim the scan revokes later aliases.
  Sandboxed alias creation is denied by PSEC even inside the writer's own scope; keep the native
  `--link-fresh` regression that proves a self-created file cannot be hardlinked, so the rename
  boundary stays reachable only from outside the sandbox.
  Journaled placeholder and temporary cleanup is deferred until the last active helper exits, so a
  finished command's temporary tree can outlive it while a peer is running. Networking remains per
  command.
- PSEC uses its exact AppContainer SID on a new private desktop. Suspend before job assignment,
  inherit only stdio, and kill descendants on exit. ConPTY close must release native resources even
  after its exit event; verify that the test process terminates naturally.
- Keep Windows/Program Files/ProgramData/PATH/executable read grants bounded; do not grant volume
  roots to fix startup. PowerShell uses a workspace provider drive. Node uses fixed preserve-symlink
  options; document that compatibility tradeoff. Pass the sanitized environment explicitly,
  preserving LOCALAPPDATA required by PSEC; never recreate an unsanitized login environment.
- Validate native NULL-DACL fixtures, private desktop, hardlinks, missing metadata, all 13 Shell
  tests plus seven PSEC parity tests with zero skips, and installed candidate setup/readiness. Use packet delivery assertions
  for UDP. Keep older-host runs and clean-host acceptance distinct from this local PSEC run.

- Carry `readOnlyRoots`, `allowLocalBinding`, and `writableTemp` through managed config, run and
  child snapshots, SQLite spawn configs and every process consumer. Persist read denies too.
  Child policies cannot discard readonly masks or broaden loopback/temporary authority. File
  mutation tools apply readonly masks even under an approved Full Access override.
- PSEC supports custom read roots and unrestricted filesystem with constrained networking.
  Full-disk grants snapshot accessible logical drives and immediate entries, resolving supported
  local reparse targets before applying readonly/denied masks, metadata and sandbox-state protection.
  Unresolvable generated grants may be skipped; explicit roots fail closed. Do not claim arbitrary
  UNC or volume-GUID target support. Legacy rejects PSEC options.
- Shell and configured Hook host launches share `windowsCmdVerbatimArguments` for
  canonical `cmd /d /s /c` invocations. Keep cmd command text intact with one outer
  quote pair; ordinary executable argv and helper request payloads retain normal
  encoding. Bundle regressions exercise quoted paths containing spaces and `&`.
- Payloads over 12,000 JSON characters travel via bounded 4096-character base64 environment
  chunks, max 1,000,000 UTF-8 bytes. Shell/hooks/plugins/MCP merge helper-owned env last; native
  validation precedes execution and clears all carrier variables before launching the workload.
- Workspace/full PSEC requests allocate a journaled GUID TMPDIR by default; read-only defaults
  off. `writable_tmp=false` disables only this additional directory, not Windows-managed private
  TEMP/TMP. Never grant host TEMP. Cleanup after the last helper removes only recorded GUID trees,
  pins ancestors, does not follow reparses and bounds traversal; failures retain recovery state.

### Scenario: Structured PSEC Egress Rules

#### 1. Scope / Trigger

- Trigger: adding or changing managed network allowlists, the request `network_egress` field, or
  the native endpoint-rule construction.

#### 2. Signatures

- Managed config: `[execution_policy.network_egress]` with `default = "deny"` and optional
  `allow`/`deny` arrays of `{ to = [{ cidr, except }], ports = [{ protocol, port, end_port }] }`.
- Profile: `ExecutionPolicy.networkEgress?: NetworkEgressPolicy`
  (`freezeNetworkEgress` in `@mycli/core`).
- Request: `network_egress: { default, allow?, deny? }` with snake_case `end_port`.

#### 3. Contracts

- Structured policies are deny-by-default allowlists. `default = "allow"` is rejected: host
  loopback is authorized only by an explicit allow rule, and "allow everything" stays the plain
  `network = "enabled"` profile without rules.
- Bounds: 32 rules per list, 8 destinations per rule, 8 exclusions per destination, 8 port
  entries per rule; CIDRs must parse as IPv4 (<= /32) or IPv6 (<= /128); ports are 0-65535 with
  `end_port >= port`.
- Structured rules cannot be combined with `allowed_network_domains` (managed proxy) or disabled
  networking; the tools launcher and the native parser both fail closed.
- Only the PSEC backend enforces the rules. The legacy restricted-token backend rejects any
  request carrying `network_egress` before launch (`sandbox_policy_requires_psec`).
- The rules travel through managed config, coordinator constraints, the run snapshot and child
  spawn authority without widening: every hop re-validates and re-freezes the policy.

#### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Non-deny default, empty list, unknown field | Managed load and native parse reject |
| Invalid CIDR, prefix, protocol, inverted range | Managed load and native parse reject |
| Rules plus domains/proxy/disabled network | Launcher rejects before spawn |
| Rules on the legacy backend | Helper rejects before launch |
| Valid rule matching a destination | PSEC allows the connection |
| No matching rule or empty deny default | PSEC blocks the connection (timeout) |

#### 5. Good / Base / Bad Cases

- Good: deny all egress except `10.0.0.0/8:443` while keeping host loopback denied by default.
- Base: no `network_egress` keeps the existing enabled/disabled/proxy behaviors unchanged.
- Bad: treating `default = "allow"` as an allowlist, dropping rules on snapshot round-trip, or
  silently falling back to unrestricted networking when the helper is legacy.

#### 6. Tests Required

- `execution-policy.test.ts`: bounds, CIDR/protocol/port validation, deny-default enforcement.
- `process-sandbox.test.ts`: request serialization (`end_port`) and combination rejections.
- `managed-execution-policy.test.ts`: TOML parsing plus contradictory combinations.
- `run-execution-snapshot.test.ts`, `agent-thread-store.test.ts`: round-trip without dropping
  rules and rejection of malformed values.
- `windows_psec_tests.cpp`: real enforcement - explicit allow connects, unmatched rule and empty
  deny default time out.

#### 7. Wrong vs Correct

Wrong: encode rich rules as extra proxy ports, or let a snapshot rebuild the profile without
`networkEgress` so a resumed turn silently regains unrestricted egress.
Correct: carry the frozen policy through every hop and re-validate it at the native boundary.
