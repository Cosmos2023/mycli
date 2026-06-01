# Doctor Tool Environment Check

## Problem

The tools hardening goal requires doctor to check tool manifest, tool
availability, shell environment, and log redaction. Manifest and redaction
checks already exist; shell/git environment availability needs an explicit
doctor row.

## Scope

- Add a `tool_environment` doctor check.
- Validate configured shell and git availability without running shell commands.
- Add unit tests for ok and warning states.

## Non-goals

- No provider calls.
- No command execution from doctor.
- No MCP/ACP/productized external tools.

## Acceptance

- Doctor reports `tool_environment=ok` when shell and git are available.
- Doctor reports actionable warning when shell or git are missing.
- Full Python verification passes.
