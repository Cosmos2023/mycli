# Tool Effect Trace Enrichment

## Goal

Enrich local `tool_execution` trace payloads with the internal tool effect profile so later diagnostics can distinguish read-only calls, structured file writes, and unknown shell effects without changing model-visible request shape.

## Requirements

- Add local effect profile fields to `tool_execution` trace payloads.
- Include:
  - `filesystem_effect`
  - `network_effect`
  - `process_effect`
- Use the existing `ToolRouter.effect_profile()` / `ToolRegistry.effect_profile()` contract.
- Preserve existing trace fields and CLI `/trace` compatibility.
- Do not add effect metadata to `ToolSpec`, rendered model tools, prompts, or stable request fragments.

## Non-Goals

- No permission policy changes.
- No Bash filesystem detection.
- No dashboard work.
- No provider-visible prompt changes.

## Acceptance Criteria

- Read-only tool traces report `filesystem_effect=read`.
- Structured file-write tool traces report `filesystem_effect=write`.
- Bash traces report `filesystem_effect=unknown` and `process_effect=true`.
- Request-shape stable hashes remain unchanged.
- Full tests, lint, and type checks pass.
