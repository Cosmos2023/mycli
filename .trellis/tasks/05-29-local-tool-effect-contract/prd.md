# Local Tool Effect Contract

## Goal

Add local-only side-effect metadata for tools so diagnostics and future guardrails can reason about read-only tools, structured file mutations, and unknown shell effects without changing model-visible tool schemas or stable prompt surfaces.

## Requirements

- Define a small internal tool effect contract.
- Classify:
  - `Read`, `Grep`, `Glob`, and `LS` as filesystem read tools.
  - `Edit` and `Write` as filesystem write tools through the existing mutation contract.
  - `Bash` as process execution with unknown filesystem effects.
- Expose the contract through `ToolRegistry` and `ToolRouter`.
- Keep `ToolSpec` unchanged.
- Do not change rendered model tool definitions, stable tool schema hash, or tool order hash.
- Keep the contract local-only for diagnostics/guardrails.

## Non-Goals

- No permission policy rewrite.
- No Bash filesystem-effect detection.
- No prompt-visible tool warnings.
- No new dependencies.

## Acceptance Criteria

- Tests prove local tools return the expected effect profile.
- Tests prove router can query effect profiles without executing tools.
- Request-shape stable hashes remain unchanged because effect metadata is not part of rendered tools.
- Full test, lint, and type checks pass.
