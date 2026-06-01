# Git Dev Workflow Notes

## Current state

- Built-in local tools have a manifest and metadata contract.
- Only `Lint` is currently in the `dev` toolset.
- The system prompt still routes git inspection through `Bash`, which is useful
  as a fallback but too unstructured for routine dirty-worktree inspection.

## Target

Add read-only git tools that return stable payloads for runtime/model/TUI use:

- no shell execution
- bounded text payloads
- stable error kinds
- compact formatter output
- no destructive commands
