# Codex-Style Persistent Shell Approvals Design

**Date:** 2026-07-17

**Status:** Approved for implementation planning

## Goal

Allow a user to convert an eligible Shell approval into a persistent global execpolicy rule, following Codex's rule-amendment model. The rule is written to `~/.mycli/rules/default.rules`, becomes effective in the current runtime immediately, and remains available to future mycli sessions.

Persistent approval must be explicit, narrowly scoped, resistant to command and configuration injection, and unavailable when mycli cannot prove that the proposed prefix safely corresponds to the command awaiting approval.

## Current Behavior

mycli currently supports:

- `approve_once`, which resumes the suspended tool call once
- `allow_session`, which stores a shell-kind-scoped command pattern in the current session
- `reject`, which clears the suspended approval without executing the tool
- user and project `default.rules` files containing `prefix_rule(...)` declarations
- loading user rules from `~/.mycli/rules/default.rules`
- loading project rules from `<workspace>/.mycli/rules/default.rules`

The execpolicy loader is read-only. Approval resolution never writes `default.rules`, and `/permissions allow` creates only a session allowance. Users must currently create persistent rules by hand and restart or rebind the runtime before those rules are loaded.

## User Experience

The Shell approval selector gains a fourth action when a validated rule proposal is available:

```text
1. Allow once
2. Reject
3. Allow for session
4. Always allow
```

`Always allow` means:

1. Append an `allow` prefix rule to the global user policy file.
2. Refresh the current runtime's in-memory execpolicy.
3. Resume the suspended Shell call once.

When no validated proposal exists, the selector remains unchanged and does not display `Always allow`.

The approval preview shows a bounded, redacted representation of the proposed prefix. It never exposes a secret removed from the command preview.

## Shell Tool Contract

The model-visible `Shell` tool gains an optional structured argument:

```json
{
  "command": "python -m pytest -q",
  "prefix_rule": ["python", "-m", "pytest"]
}
```

`prefix_rule` is policy metadata. It is never:

- concatenated into the command string
- passed to the child process
- added to the shell environment
- included in raw command diagnostics
- interpreted as sufficient authorization without user confirmation

The hidden legacy `Bash` alias continues accepting its existing schema. Persisted or replayed legacy calls without `prefix_rule` remain compatible and simply cannot offer `Always allow`.

## Approval Data Model

Add an optional immutable field to `PendingApproval` and `PendingDecision`:

```text
proposed_execpolicy_pattern: tuple[str, ...] | None
```

The field stores validated tokens, not a command string and not the redacted `command_pattern` used by session allowances.

The field is carried through:

- approval service output
- suspended turn persistence
- pending decision persistence
- history and resume reconstruction
- Python-to-Node gateway payloads
- TUI approval option projection

Session snapshots remain backward compatible when the field is absent.

Add `always_allow` to the stable decision-choice taxonomy and `DecisionAction` enum. Existing numeric mappings remain stable:

```text
1 -> approve_once
2 -> reject
3 -> allow_session
4 -> always_allow
```

## Candidate Validation

Introduce a pure `ExecPolicyProposalValidator`. It accepts:

- the active `ShellKind`
- the original structured `args` or command string
- the model-provided `prefix_rule`
- the runtime policy source that caused approval

It returns either validated immutable tokens or a non-sensitive rejection reason.

### Structural Requirements

A proposal is eligible only when:

- `prefix_rule` is a non-empty array of non-empty strings
- the command parses as plain syntax through `shell_command_policy`
- the proposed tokens are an exact prefix of one parsed executable segment
- the matched segment is the segment that requires approval
- the proposal does not cross `&&`, `||`, `;`, or pipeline boundaries
- the call did not require approval because of project or user `ask` policy
- no explicit `deny` rule matched

Structured `args` are validated as one literal segment. String commands use the active shell parser. Complex or invalid parse results are ineligible.

### Sensitive Values

Reject a proposal containing:

- a value following token, password, secret, key, auth, or credential flags
- an environment assignment whose key indicates a secret
- a token that matches the existing sensitive-value heuristics
- a value that was redacted from the approval preview

Validation uses the existing shared sensitive-argument rules rather than maintaining a second list.

### Broad Prefixes

Reject exact broad prefixes that permit arbitrary code execution or uncontrolled escalation, including:

```text
python
python -c
python3
python3 -c
py
node
node -e
bash
bash -lc
sh
sh -c
zsh
zsh -lc
pwsh
pwsh -Command
powershell
powershell -Command
env
sudo
osascript
```

Specific interpreter-backed workflows remain eligible, for example:

```text
python -m pytest
python -m ruff
npm run test
uv run pytest
cargo test
```

The validator compares executable basenames and shell-appropriate case normalization so absolute interpreter paths cannot bypass broad-prefix checks.

### Destructive Prefixes

Never offer persistent approval for high-confidence destructive families, including:

- `rm`
- `rmdir` and platform delete aliases
- `git reset --hard`
- `git clean`
- force push forms
- recursive `chmod` or `chown`
- disk and shutdown utilities already classified as dangerous
- PowerShell destructive cmdlets and CMD destructive commands

These commands may still use `approve_once` when the existing policy permits it. Session allowance behavior remains unchanged unless the command has no eligible command pattern.

## Persistent Rule Writer

Add `ExecPolicyWriter` beside the existing loader in the execpolicy service boundary.

Its only target is:

```text
~/.mycli/rules/default.rules
```

Runtime approvals never modify project rules. Project policy remains a manually reviewed repository concern and retains higher precedence over user rules.

The writer:

1. Creates `~/.mycli/rules` when necessary.
2. Applies private directory permissions using `harden_private_path`.
3. Acquires a cross-platform advisory lock associated with `default.rules`.
4. Reads and parses the current file while holding the lock.
5. Treats an identical existing `allow` rule as success without appending.
6. Serializes every token with JSON string encoding.
7. Builds complete replacement contents that preserve existing comments and rules and append one newline-terminated declaration.
8. Writes the replacement to a unique temporary file in the rules directory, applies private file permissions, flushes it, and synchronizes it.
9. Atomically publishes the replacement with `os.replace` while still holding the lock.
10. Synchronizes the rules directory on platforms that support directory `fsync`, then releases the lock.

The lock uses a dedicated lock file rather than the rules file itself, so replacing
`default.rules` does not invalidate synchronization between concurrent writers. A
failure before `os.replace` leaves the previous rules file unchanged; abandoned
temporary files are removed on the best-effort cleanup path.

Generated syntax is:

```text
prefix_rule(pattern=["python", "-m", "pytest"], decision="allow")
```

The writer never accepts a preformatted rule string from the model or UI.

### Cross-Platform Locking

Use a small standard-library lock adapter:

- POSIX: `fcntl.flock(..., LOCK_EX)`
- Windows: `msvcrt.locking(...)` on a dedicated lock file

Lock acquisition and release are context-managed. A failure is reported as a typed write error; mycli does not continue as though persistence succeeded.

## Runtime Refresh

After a successful or deduplicated write:

1. Reload rules through `ExecPolicyLoader`.
2. Replace `AgentRuntime._execpolicy_rules`.
3. Update `RuntimePolicyGate` with the new rule set and current sandbox configuration.
4. Refresh the runtime environment contract used for model context and diagnostics.
5. Resume the approved tool call with one-call approval already established.

No process restart or workspace rebind is required.

The refresh path is a named runtime method shared by persistent approval and future permission-management commands. Approval resolution does not directly mutate private rule collections in several components.

## Resolution Flow

`always_allow` resolution follows this order:

```text
load pending decision and suspended turn
        |
validate choice and proposed pattern presence
        |
write or deduplicate global rule
        |
reload and publish runtime execpolicy
        |
record bounded approval audit event
        |
clear pending state
        |
resume approved Shell call once
```

The audit event records only:

- decision action
- shell kind
- rule source `user`
- pattern token count
- pattern hash
- write result `created` or `existing`

It does not record pattern tokens or the raw command.

## Failure Semantics

If validation, lock acquisition, directory creation, file write, fsync, parse, or runtime refresh fails:

- do not execute the suspended Shell call
- do not clear the pending decision or suspended turn
- do not add a session allowance
- return a bounded actionable error
- preserve `approve_once`, `reject`, and eligible `allow_session` choices

If the atomic replacement succeeds but runtime refresh fails, report that the rule was persisted but not activated. Keep the current call pending so the user can restart mycli or choose `approve_once`; a retry deduplicates the existing rule.

Approval recovery after process restart reconstructs `always_allow` only when the persisted pending decision contains a validated proposed pattern.

## TUI And Gateway

Extend the gateway schema and TUI approval selector with `always_allow` and label `Always allow`.

The TUI renders only options supplied by the backend. It never derives a rule from command display text. Numeric and mnemonic keyboard handling remain owned by the selector, and older snapshots without the new option continue rendering normally.

No Shell lifecycle or tool-result display changes are required.

## Testing Strategy

Implementation follows test-driven development.

### Proposal Validation

- accepts a matching narrow proposal for a single unknown segment
- accepts a proposal for the unknown segment in a safe composite command
- rejects empty, non-string, non-prefix, and cross-segment proposals
- rejects complex syntax and malformed commands
- rejects sensitive values and redacted arguments
- rejects broad interpreter, shell, escalation, and destructive prefixes
- normalizes POSIX, PowerShell, CMD, and absolute executable names
- suppresses persistent approval for explicit `ask` and `deny` policy results

### Writer

- creates the global rules directory and file
- emits exactly parseable JSON-escaped rule syntax
- appends without corrupting an existing final line
- deduplicates an identical allow rule
- preserves unrelated comments and rules
- applies private permissions on POSIX and tolerates unsupported chmod on Windows
- serializes concurrent writers through the lock adapter
- leaves the file parseable after simulated write failures

### Approval And Runtime

- exposes `always_allow` only with a validated proposal
- persists and restores proposed patterns in session state
- maps choice `4` and gateway `always_allow` consistently
- writes, refreshes, and resumes exactly once
- makes the new rule effective in the same runtime
- keeps pending state on write or refresh failure
- records only bounded hashed audit metadata
- preserves existing approve-once, reject, and session-allowance flows

### TUI

- renders `Always allow` when supplied
- omits it when no proposal exists
- submits the stable `always_allow` choice
- preserves numeric and mnemonic approval shortcuts
- replays older approval snapshots without schema errors

Full Python, Ruff, Mypy, TypeScript, and Node TUI suites must pass.

## Compatibility

- Existing `default.rules` syntax and precedence remain unchanged.
- Existing sessions deserialize without `proposed_execpolicy_pattern`.
- Existing providers may omit `prefix_rule` without failure.
- Legacy Bash calls remain executable through existing approval actions.
- Project rules continue overriding user rules.
- The new argument does not change Shell execution output, cache formatting, PTY behavior, or background session behavior.

## Non-Goals

- Editing project `.mycli/rules/default.rules` from runtime approval.
- Automatically deriving a persistent rule when the model omitted `prefix_rule`.
- Persisting arbitrary full command strings.
- Allowing users to override managed project `ask` or `deny` rules globally.
- Adding a general rules editor to the TUI.
- Migrating existing session allowances into global rules.
