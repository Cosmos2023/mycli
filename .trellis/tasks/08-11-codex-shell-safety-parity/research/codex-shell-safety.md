# Codex shell safety comparison

The local Codex source separates command classification from sandbox
escalation. `is_known_safe_command()` identifies commands that may bypass the
strict `unless-trusted` prompt path. `command_might_be_dangerous()` catches
destructive or GUI-launch cases. Under `on-request`, unmatched non-dangerous
commands run in a restricted sandbox unless the call explicitly requests a
sandbox override.

Relevant Codex sources:

- `/Users/cosmos/Downloads/codex-main/codex-rs/shell-command/src/command_safety/is_safe_command.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/shell-command/src/command_safety/is_dangerous_command.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/shell-command/src/command_safety/windows_safe_commands.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/shell-command/src/command_safety/windows_dangerous_commands.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/core/src/exec_policy.rs`

Node mycli already matches the primary POSIX direct-command list and most
`base64`, `find`, `rg`, `sed`, and read-only Git checks. Current differences:

- mycli prompts on every unknown command before sandbox execution;
- mycli has no explicit provider-visible sandbox override request;
- Codex rejects more Git global/subcommand options;
- the PowerShell/CMD safe and dangerous tables have drifted;
- mycli intentionally accepts read-only `git branch --list <pattern>` and can
  validate a workspace-relative `git -C` more precisely than Codex's blanket
  rejection.

Recommended mapping:

- keep mycli's explicit provider-order approval continuation;
- introduce `sandbox_permissions` only on the model-visible `Shell` route;
- carry host authorization separately from model arguments;
- keep Full Access prompt-free while preserving explicit restrictive rules;
- do not persist raw model justification or command text in approval metadata.
