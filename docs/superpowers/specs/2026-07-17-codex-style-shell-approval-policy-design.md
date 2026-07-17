# Codex-Style Shell Approval Policy Design

**Date:** 2026-07-17

**Status:** Approved for implementation planning

## Goal

Replace mycli's permissive unmatched-command fallback with a Codex-style positive safelist for local Shell execution. Commands that are demonstrably read-only and structurally simple run without approval. Explicitly dangerous commands remain denied or require approval. Commands that are unknown, ambiguous, or use unsupported shell syntax require approval by default.

The policy must behave consistently on Linux, macOS, and Windows while preserving the existing sandbox, collaboration-mode restrictions, `prefix_rule` files, session allowances, approval UI, command preview redaction, and unified Shell runtime.

## Current Behavior And Gaps

mycli already has four relevant policy layers:

- collaboration-mode and sandbox restrictions in `RuntimePolicyGate`
- user and project `prefix_rule` loading with `allow`, `ask`, and `deny` decisions
- session-scoped command allowances created after user approval
- Shell safety analysis for a small set of forbidden and confirmation-required patterns

The POSIX Shell fallback is currently negative-list based. A command is automatically allowed when it does not match a known dangerous pattern. Consequently, arbitrary commands such as `python script.py` and `npm install` may run without approval.

Command composition is also handled too coarsely. Every POSIX `&&`, `||`, or `;` currently requires approval, including read-only expressions such as `cd src && cat app.py`. Conversely, an explicit prefix rule can match the beginning of the entire token list without independently evaluating later command segments.

The PowerShell and CMD adapters are already conservative for unknown commands, but they reject all composition rather than proving that each segment is safe.

## Policy Semantics

The final decision order is:

```text
collaboration mode and sandbox hard restrictions
                    |
                    v
parse command into independently evaluated segments
                    |
                    v
explicit execpolicy rule for each segment
                    |
                    v
known-dangerous and known-safe fallback classification
                    |
                    v
aggregate segment decisions
                    |
                    v
allow / request approval / deny
```

The result for a composed command is the strictest segment result:

```text
deny > ask or unknown > allow
```

A composed command is automatically allowed only when every executable segment is allowed by an explicit rule or the built-in safe-command classifier. An explicit `allow` for the first segment never implicitly approves later segments.

Existing `prefix_rule` decisions remain authoritative for the segment they match:

- `deny` denies the complete Shell call.
- `ask` requires approval for the complete Shell call.
- `allow` approves that segment and permits evaluation to continue.
- an unmatched segment falls back to built-in dangerous and safe-command classification.

Session allowances are evaluated after command classification and remain scoped to the active shell kind and derived command pattern. They may satisfy an approval result, but never override sandbox, collaboration-mode, explicit `deny`, or a hard parse failure.

## Architecture

Add a dedicated `shell_command_policy` module. It owns conservative parsing, segment representation, known-safe classification, and aggregate classification. It does not execute commands or render approval UI.

Conceptual types:

```text
ShellCommandSegment
  words
  operator_before
  effective_cwd
  shell_kind

ShellParseResult
  segments
  used_complex_syntax
  failure_reason

ShellCommandClassification
  decision: safe | unknown | dangerous | invalid
  reason
  command_pattern
  segments
```

The existing modules retain focused responsibilities:

- `shell_command_policy`: parse and classify command structure
- `shell_safety`: redact previews and detect existing high-confidence dangerous patterns
- `shell_safety_adapters`: select behavior for POSIX, PowerShell, and CMD profiles
- `execpolicy`: load rules and match each parsed segment
- `RuntimePolicyGate`: combine sandbox, collaboration mode, execpolicy, classifier, and approval service outcomes
- `ApprovalService`: create pending approvals and apply session allowances

The TUI receives the same pending-approval and Shell lifecycle contracts. It does not parse commands or make policy decisions.

## Conservative Parsing

### POSIX Shells

For Bash, Zsh, and POSIX `sh`, support plain commands made from bare or quoted words and these control operators:

- `&&`
- `||`
- `;`
- `|`

Each command on either side of an operator becomes an independent segment. A leading chain of plain `cd <path> && ...` segments updates `effective_cwd` for path-aware classification and display metadata without rewriting the command sent to the shell.

The parser treats the following constructs as complex and returns an approval-required result:

- output or input redirection
- command and process substitution
- background execution with `&`
- heredocs and herestrings
- variable assignment or expansion
- wildcard expansion
- subshells and grouped commands
- shell functions and loops
- malformed quoting or empty executable segments

Simple `bash -lc`, `zsh -lc`, and `sh -lc` wrappers may be lowered only when their script body satisfies the same plain-command grammar. Nested or dynamic wrappers require approval.

### PowerShell

PowerShell parsing supports simple command words and safe composition through pipelines, `;`, `&&`, and `||` when every segment is independently safe. Variable expansion, subexpressions, script blocks, redirection, splatting, invocation operators, and malformed quoting require approval.

PowerShell command names are compared case-insensitively. Native executables shared with the POSIX safelist, such as `rg` and read-only Git commands, use the same argument checks after executable-name normalization.

### CMD

CMD retains conservative support for direct read-only commands and gains segment evaluation for simple `&`, `&&`, `||`, and `|` composition. Percent expansion, delayed expansion, redirection, parenthesized groups, and malformed quoting require approval.

CMD is included because it is mycli's Windows fallback when PowerShell is unavailable, even though PowerShell is the preferred Windows shell.

## Built-In Safe Commands

The initial POSIX safelist follows Codex's known-safe command family:

- direct read-only utilities: `cat`, `cd`, `cut`, `echo`, `expr`, `false`, `grep`, `head`, `id`, `ls`, `nl`, `paste`, `pwd`, `rev`, `seq`, `stat`, `tail`, `tr`, `true`, `uname`, `uniq`, `wc`, `which`, and `whoami`
- Linux-only read utilities: `numfmt` and `tac`
- `base64` when no output-file option is present
- `find` when it does not use execution, deletion, or file-output options
- `rg` when it does not invoke preprocessors, custom hostname commands, or zip-search helpers
- `sed` only in validated `sed -n Np` or `sed -n M,Np` forms
- read-only Git subcommands: `status`, `log`, `diff`, `show`, and non-mutating `branch` forms

Executable matching uses the basename so an absolute path to a known executable can be classified consistently. Shell aliases and functions are not assumed to be safe.

The initial PowerShell safelist includes `Get-Location`, `Get-Date`, `Get-ChildItem`, `Get-Content`, `Get-Command`, and `Test-Path`, plus safe native commands and read-only Git forms. `Select-Object`, `Sort-Object`, and `Measure-Object` are allowed as pipeline segments only with literal word arguments; calculated properties, expressions, and script blocks require approval. `Where-Object` is not safelisted because its normal form executes a script block.

The CMD safelist remains intentionally small: `cd`, `dir`, `echo`, `type`, `where`, safe native commands, and read-only Git forms.

Argument-sensitive checks are required. A safe executable name alone is insufficient for commands such as `find`, `rg`, `base64`, `sed`, and `git`.

## Examples

Automatically allowed:

```bash
cat README.md
cd src && sed -n '1,120p' app.py
rg -n "approval" src | head -n 20
git status --short
git -C repo diff --stat
```

Approval required because a segment is unknown:

```bash
python script.py
npm install
cat README.md && python script.py
```

Approval required because syntax is complex:

```bash
cat "$HOME/file"
echo hello > output.txt
cat <(generate-input)
for file in *.py; do cat "$file"; done
```

Explicit rules are applied per segment:

```text
prefix_rule(pattern=["python", "-m", "pytest"], decision="allow")
```

With that rule, `python -m pytest -q && git status` is allowed because both segments are independently allowed. `python -m pytest -q && npm publish` still requires approval unless another rule allows the second segment.

## Error Handling And Security Boundaries

- Empty commands and Unicode bidirectional or formatting controls remain denied.
- Known catastrophic patterns, including the existing root recursive-delete and fork-bomb checks, remain denied by fallback policy.
- Unsupported or ambiguous syntax is not interpreted heuristically; it requires approval.
- Parse errors do not fall back to the old permissive behavior.
- Approval previews continue to redact token, password, secret, key, auth, and credential values.
- Rules are never generated automatically from commands that use complex syntax.
- Broad interpreter prefixes such as `python`, `bash -lc`, or `pwsh -Command` are not suggested as persistent allowances.
- Raw commands remain excluded from diagnostic traces that currently store only hashes, lengths, patterns, and bounded previews.

An explicitly configured `allow` rule represents user or administrator intent and can override fallback dangerous-command heuristics for the segment it matches. Sandbox and collaboration-mode hard restrictions still take precedence.

## Compatibility And Migration

No model-visible tool schema changes are required. `Shell`, `WriteStdin`, and hidden legacy aliases retain their current parameters and result formats.

This is intentionally a stricter default for POSIX Shell calls. Commands that were previously auto-allowed only because they missed the negative list will begin requesting approval. Dedicated read tools, explicit `prefix_rule` entries, and session approvals provide the expected low-friction paths.

Existing rule files remain valid:

```text
~/.mycli/rules/default.rules
<workspace>/.mycli/rules/default.rules
```

Rule loading, source precedence, and trace metadata remain compatible. Matching changes from whole-call token-prefix matching to per-segment matching, closing the case where an allowed first command could conceal an unapproved later command.

## Testing Strategy

Implementation follows test-driven development. Tests must first demonstrate the permissive or coarse behavior being replaced.

Unit coverage includes:

- each direct POSIX safe command
- argument restrictions for `base64`, `find`, `rg`, `sed`, and Git
- safe and unsafe `git branch` forms
- executable basename normalization
- safe `&&`, `||`, `;`, and pipeline composition
- leading `cd` cwd tracking
- mixed safe and unknown segments
- redirection, substitution, expansion, wildcard, grouped-command, and malformed-input fallback
- safe and unsafe shell-wrapper lowering
- PowerShell case-insensitive commands and conservative composition
- CMD safe commands and expansion fallback
- preview redaction and existing hard-deny behavior

Policy integration coverage includes:

- unmatched safe command becomes `allowed`
- unmatched unknown command becomes `needs_approval`
- explicit `allow`, `ask`, and `deny` are applied per segment
- a safe first segment cannot hide an unknown or denied later segment
- session allowance satisfies only the matching shell kind and pattern
- sandbox and plan-mode denials precede shell classification
- approval resolution resumes execution exactly once
- live and resumed TUI approval rendering remains unchanged

The full Python and Node TUI suites, Ruff, Mypy, and TypeScript checks must pass before completion.

## Non-Goals

- Implementing a complete Bash, PowerShell, or CMD language parser.
- Rewriting leading `cd` commands into the Shell tool's `cwd` parameter.
- Changing TUI command classification or exploration grouping.
- Automatically creating persistent rules without user approval.
- Bypassing filesystem, network, or collaboration-mode restrictions for safelisted commands.
- Removing the existing dedicated `Read`, Git, search, or listing tools.
