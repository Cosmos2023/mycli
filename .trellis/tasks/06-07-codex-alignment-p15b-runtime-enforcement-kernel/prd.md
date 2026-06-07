# Codex Alignment P15b Runtime Enforcement Kernel

## Problem

P15a makes runtime posture visible to the model, but the shell execution path still has enforcement gaps compared with the contract it advertises. Bash/run_shell already flows through `RuntimePolicyGate` and has basic workspace cwd validation, timeout, and output truncation. However, runtime execution does not yet carry a typed, bounded enforcement contract for shell execution options, does not cap user-supplied timeout consistently from policy, and still inherits the full process environment into shell commands.

## Goal

Add a minimal provider-free runtime enforcement kernel for shell execution that turns the P15a model-visible runtime posture into concrete runtime execution options. The kernel should standardize workspace cwd, sanitized environment policy, timeout cap, output limits, and bounded diagnostics for Bash/run_shell without adding OS-level sandboxing or touching compact/rehydration.

## Scope

- Add typed shell execution options derived from `ExecutionPolicy` / `SandboxProfile`.
- Enforce workspace cwd for shell calls through the existing Bash cwd resolver.
- Enforce a max shell timeout regardless of model/user-provided timeout.
- Execute shell commands with a sanitized allowlisted environment instead of inheriting the full process env.
- Preserve required shell basics such as `PATH`, `HOME`, `SHELL`, `LANG`, and terminal-related values when present.
- Add bounded enforcement metadata to Bash raw payloads and tool execution trace summaries.
- Keep raw env values, raw command text, raw execpolicy rule tokens, stdout/stderr bodies, and provider payload bodies out of trace/doctor/dry-run summaries.
- Keep P14 execpolicy allow/deny/ask behavior intact.
- Keep P15a environment context dynamic and current user input last.

## Non-goals

- No OS-level sandbox backend.
- No chroot/container/seccomp/seatbelt implementation.
- No network firewall.
- No non-shell execpolicy expansion.
- No complete env allowlist configuration UI.
- No real provider API calls.
- No compact/rehydration implementation changes.

## Acceptance

- Unit tests prove Bash caps timeout to runtime policy max.
- Unit tests prove Bash shell execution receives sanitized env and does not inherit arbitrary secret env values.
- Unit tests prove cwd remains workspace-bound and bounded enforcement metadata is present.
- Unit tests prove runtime policy trace/tool execution diagnostics expose only bounded enforcement fields.
- Existing P14 execpolicy allow/deny/ask tests keep passing.
- `uv run ruff check src tests evaluation` passes.
- `uv run mypy src/mycli` passes.
- `uv run pytest -q` passes.
- Context/provider-cache smoke does not regress.
- Compact/rehydration implementation files remain untouched.
